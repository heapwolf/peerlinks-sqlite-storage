import sqlite from 'sqlite3';
import { Buffer } from 'buffer';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

// The real limit is 999, but we want few extra
const MAX_VARIABLE_COUNT = 900;

const CURRENT_VERSION = 2;

export default class SqliteStorage {
  /**
   * In-memory persistence.
   *
   * @class
   */
  constructor(options = {}) {
    this.db = null;
    this.options = options;
  }

  async open() {
    let file;
    if (this.options.file) {
      file = this.options.file;
    } else {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peerlinks-'));
      file = path.join(tmpDir, 'tmp.db');
    }

    this.db = await new Promise((resolve, reject) => {
      const db = new sqlite.Database(file, (err) => {
        if (err) {
          return reject(err);
        }
        resolve(db);
      });
    });

    if (this.options.trace) {
      this.db.on('trace', (query) => {
        console.error(query);
      });
    }

    const methods = [
      'close',
      'get',
      'run',
      'all',
    ];

    // NOTE: Lame, but works
    for (const method of methods) {
      this.db[method + 'Async'] = promisify(this.db[method]);
    }

    await this.createTables();

    await this.db.runAsync('PRAGMA locking_mode = EXCLUSIVE;');

    // For future migrations
    const { user_version: lastVersion } =
      await this.db.getAsync('PRAGMA user_version;');

    // Sadly, old messages and channels are not compatible with the new
    // version of the protocol
    if (lastVersion < CURRENT_VERSION) {
      await this.clear();
    }

    // For future migrations
    await this.db.runAsync(`PRAGMA user_version = ${CURRENT_VERSION};`);
  }

  async close() {
    await this.db.close();
  }

  async createTables() {
    let promise;
    this.db.serialize(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS messages(
          channel_id BLOB,
          hash BLOB,
          parent_hashes BLOB,
          height INT,
          blob BLOB,
          PRIMARY KEY(hash ASC)
        );
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS crdt ON messages(
          channel_id,
          height ASC,
          hash ASC
        );
      `);

      this.db.run(`
        CREATE TABLE IF NOT EXISTS parents(
          channel_id BLOB,
          hash BLOB,
          PRIMARY KEY(hash ASC)
        );
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS channel_id ON parents(channel_id);
      `);
      this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS hash ON parents(hash);
      `);

      this.db.run(`
        CREATE TABLE IF NOT EXISTS entities(
          prefix TEXT,
          id TEXT,
          blob BLOB
        );
      `);

      promise = this.db.runAsync(`
        CREATE UNIQUE INDEX IF NOT EXISTS entity_id ON entities(prefix, id);
      `);
    });
    return await promise;
  }

  //
  // Messages
  //

  async addMessage(message) {
    let promise;
    this.db.serialize(() => {
      this.db.run('BEGIN TRANSACTION;');

      this.db.run(`
        REPLACE INTO messages (channel_id, hash, parent_hashes, height, blob)
        VALUES ($channelId, $hash, $parentHashes, $height, $blob);
      `, {
        $channelId: message.channelId,
        $hash: message.hash,
        $parentHashes: this.encodeHashList(message.parents),
        $height: message.height,
        $blob: message.data,
      });

      for (const parentHash of message.parents) {
        this.db.run(`
          REPLACE INTO parents (channel_id, hash)
          VALUES ($channelId, $hash)
        `, {
          $channelId: message.channelId,
          $hash: parentHash,
        });
      }

      promise = this.db.runAsync('COMMIT TRANSACTION;');
    });
    return await promise;
  }

  async getMessageCount(channelId) {
    const row = await this.db.getAsync(`
      SELECT COUNT(*) AS count FROM messages WHERE channel_id == $channelId
    `, { $channelId: channelId });
    return row.count;
  }

  async getLeafHashes(channelId) {
    const rows = await this.db.allAsync(`
      SELECT hash FROM messages
      WHERE messages.channel_id == $channelId AND
        messages.hash NOT IN
        (SELECT hash FROM parents WHERE channel_id == $channelId)
    `, { $channelId: channelId });

    return rows.map((row) => row.hash);
  }

  async hasMessage(channelId, hash) {
    const row = await this.db.getAsync(`
      SELECT COUNT(*) AS count FROM messages
      WHERE channel_id == $channelId AND hash == $hash
    `, { $channelId: channelId, $hash: hash });
    return row.count !== 0;
  }

  async getMessage(channelId, hash) {
    const row = await this.db.getAsync(`
      SELECT blob FROM messages
      WHERE channel_id == $channelId AND hash == $hash
    `, { $channelId: channelId, $hash: hash });
    return row ? row.blob : undefined;
  }

  async getMessages(channelId, hashes) {
    const result = new Array(hashes.length);
    const order = Array.from(hashes.entries()).sort((a, b) => {
      return Buffer.compare(a[1], b[1]);
    }).map(([ index ]) => index);

    let rows = [];
    for (let offset = 0; offset < hashes.length; offset += MAX_VARIABLE_COUNT) {
      const partialHashes = hashes.slice(offset, offset + MAX_VARIABLE_COUNT);

      const partial = await this.db.allAsync(`
        SELECT blob FROM messages
        WHERE channel_id == ? AND
          hash IN (${partialHashes.map(() => '?').join(', ')})
        ORDER BY hash
      `, channelId, ...partialHashes);

      rows = rows.concat(partial);
    }

    for (const [ i, target ] of order.entries()) {
      result[target] = rows[i].blob;
    }

    return result;
  }

  async getHashesAtOffset(channelId, offset, limit) {
    const rows = await this.db.allAsync(`
      SELECT hash FROM messages
      WHERE channel_id == $channelId
      ORDER BY height ASC, hash ASC
      LIMIT $limit OFFSET $offset
    `, { $channelId: channelId, $limit: limit, $offset: offset });
    return rows.map((row) => row.hash);
  }

  async getReverseHashesAtOffset(channelId, offset, limit) {
    const rows = await this.db.allAsync(`
      SELECT hash FROM messages
      WHERE channel_id == $channelId
      ORDER BY height DESC, hash DESC
      LIMIT $limit OFFSET $offset
    `, { $channelId: channelId, $limit: limit, $offset: offset });
    return rows.map((row) => row.hash);
  }

  async query(channelId, cursor, isBackward, limit) {
    limit = Math.max(0, limit);

    let command;
    const params = {
      $channelId: channelId,
    };

    let rows;
    if (cursor.hash) {
      // Find height of original message
      command = `
        SELECT messages.hash, messages.parent_hashes
        FROM messages JOIN messages as original
        WHERE messages.channel_id == $channelId AND
          original.channel_id == messages.channel_id AND
          original.hash == $hash AND
      `;
      params.$hash = cursor.hash;

      if (isBackward) {
        command += `
          (messages.height < original.height OR
            (messages.height == original.height AND
              messages.hash < original.hash))
          ORDER BY messages.height DESC, messages.hash DESC
        `;
      } else {
        command += `
          (messages.height > original.height OR
            (messages.height == original.height AND
              messages.hash >= original.hash))
          ORDER BY messages.height ASC, messages.hash ASC
        `;
      }
    } else {
      command = `
        SELECT hash, parent_hashes
        FROM messages
        WHERE channel_id == $channelId AND
      `;

      params.$height = cursor.height;
      if (isBackward) {
        throw new Error('Backwards query by height is not supported');
      } else {
        command += `
          height >= $height
          ORDER BY height ASC, hash ASC
        `;
      }
    }

    command += ' LIMIT $limit';
    params.$limit = limit + 1;

    rows = await this.db.allAsync(command, params);
    if (isBackward) {
      rows.reverse();
    }

    let abbreviatedMessages = rows.map((row) => {
      return {
        hash: row.hash,
        parents: this.decodeHashList(row.parent_hashes),
      };
    });
    let backwardHash = null;
    let forwardHash = null;

    if (isBackward) {
      forwardHash = cursor.hash;
      if (rows.length > limit) {
        abbreviatedMessages = abbreviatedMessages.slice(1);
        backwardHash = rows[0].hash;
      }
    } else {
      backwardHash = rows.length > 0 ? rows[0].hash : null;
      if (rows.length > limit) {
        abbreviatedMessages = abbreviatedMessages.slice(0, -1);
        forwardHash = rows[rows.length - 1].hash;
      }
    }

    return {
      abbreviatedMessages,
      backwardHash,
      forwardHash,
    };
  }

  async removeChannelMessages(channelId) {
    let promise;
    this.db.serialize(() => {
      this.db.run('BEGIN TRANSACTION;');
      this.db.run(`
        DELETE FROM messages
        WHERE channel_id == $channelId
      `, { $channelId: channelId });
      this.db.run(`
        DELETE FROM parents
        WHERE channel_id == $channelId
      `, { $channelId: channelId });
      promise = this.db.runAsync('COMMIT TRANSACTION;');
    });
    await promise;
  }

  //
  // Entities (Identity, ChannelList, so on)
  //

  async getEntityCount() {
    const row = await this.db.getAsync(`
      SELECT COUNT(*) AS count FROM entities
    `);
    return row.count;
  }

  async storeEntity(prefix, id, blob) {
    await this.db.runAsync(`
      REPLACE INTO entities (prefix, id, blob)
      VALUES ($prefix, $id, $blob);
    `, { $prefix: prefix, $id: id, $blob: blob });
  }

  async retrieveEntity(prefix, id) {
    const row = await this.db.getAsync(`
      SELECT blob FROM entities
      WHERE prefix == $prefix AND id == $id;
    `, { $prefix: prefix, $id: id });

    return row ? row.blob : undefined;
  }

  async removeEntity(prefix, id) {
    await this.db.runAsync(`
      DELETE FROM entities
      WHERE prefix == $prefix AND id == $id;
    `, { $prefix: prefix, $id: id });
  }

  async getEntityKeys(prefix) {
    const rows = await this.db.allAsync(`
      SELECT id FROM entities
      WHERE prefix == $prefix;
    `, { $prefix: prefix });

    return rows.map((row) => row.id);
  }

  //
  // Miscellaneous
  //

  async clear() {
    await Promise.all([
      this.db.runAsync('DELETE FROM messages;'),
      this.db.runAsync('DELETE FROM parents;'),
      this.db.runAsync('DELETE FROM entities;'),
    ]);
  }

  //
  // Internal
  //

  encodeHashList(list) {
    let size = 0;
    for (const elem of list) {
      if (elem.length > 0xff) {
        throw new Error('Invalid hash');
      }
      size += 1 + elem.length;
    }
    const result = Buffer.alloc(size);
    let offset = 0;
    for (const elem of list) {
      result[offset] = elem.length;
      offset++;

      elem.copy(result, offset);
      offset += elem.length;
    }
    return result;
  }

  decodeHashList(data) {
    const result = [];
    for (let offset = 0; offset < data.length;) {
      const len = data[offset];
      offset++;

      const hash = data.slice(offset, offset + len);
      offset += len;

      result.push(hash);
    }
    return result;
  }
}
