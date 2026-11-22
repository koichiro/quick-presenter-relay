// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Metadata } from "quick-presenter-relay-core";
export interface StoredRoom {
  metadata: Metadata;
  audienceHash: string;
  presenterHash: string;
}
export class Storage {
  private database: DatabaseSync;
  constructor(
    path: string,
    private key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("Storage key must have 32 bytes");
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creates(id TEXT PRIMARY KEY, response BLOB NOT NULL, expires INTEGER NOT NULL);`);
  }
  rooms(): StoredRoom[] {
    return this.database
      .prepare("SELECT record FROM rooms")
      .all()
      .map((row) => JSON.parse(String(row.record)) as StoredRoom);
  }
  save(room: StoredRoom): void {
    this.database
      .prepare("INSERT OR REPLACE INTO rooms VALUES(?, ?)")
      .run(room.metadata.id, JSON.stringify(room));
  }
  cached(id: string, now: number): Record<string, string> | null {
    this.database.prepare("DELETE FROM creates WHERE expires <= ?").run(now);
    const row = this.database.prepare("SELECT response FROM creates WHERE id = ?").get(id);
    if (!row) return null;
    const data = Buffer.from(row.response as Uint8Array);
    const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"),
    ) as Record<string, string>;
  }
  create(room: StoredRoom, id: string, config: Record<string, string>, expires: number): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), body]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.save(room);
      this.database.prepare("INSERT INTO creates VALUES(?, ?, ?)").run(id, encrypted, expires);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  prune(now: number): void {
    this.database
      .prepare("DELETE FROM rooms WHERE json_extract(record, '$.metadata.expiresAt') <= ?")
      .run(now - 86400000);
    this.database.prepare("DELETE FROM creates WHERE expires <= ?").run(now);
  }
  close(): void {
    this.database.close();
  }
}
