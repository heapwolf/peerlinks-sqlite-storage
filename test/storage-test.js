/* eslint-env node, mocha */
import * as assert from 'assert';
import { Buffer } from 'buffer';
import { randomBytes } from 'crypto';

import Storage from '../';

describe('vowlink-sqlite-storage', () => {
  let channelId = null;
  let storage = null;

  beforeEach(async () => {
    channelId = randomBytes(32);
    storage = new Storage();
    await storage.open();
  });

  afterEach(async () => {
    const s = storage;
    storage = null;
    channelId = null;

    await s.close();
  });

  const msg = (hash, height, parents = []) => {
    return {
      channelId,
      hash: Buffer.from(hash),
      height,
      parents: parents.map((hash) => Buffer.from(hash)),
      serializeData() {
        return Buffer.from(`${height}: ${hash}`);
      }
    };
  };

  const at = async (offset) => {
    const blob = await storage.getMessageAtOffset(channelId, offset);
    return blob.toString();
  };

  const leaves = async () => {
    const result = await storage.getLeaves(channelId);
    return result.map((message) => message.toString()).sort();
  };

  it('should store and retrieve messages', async () => {
    const fake = {
      channelId,
      hash: randomBytes(32),
      height: 0,
      parents: [],
      serializeData() {
        return Buffer.from('fake');
      }
    };

    assert.strictEqual(await storage.getMessageCount(channelId), 0);
    assert.strictEqual((await storage.getLeaves(channelId)).length, 0);
    assert.ok(!await storage.hasMessage(channelId, fake.hash));

    await storage.addMessage(fake);
    assert.strictEqual(await storage.getMessageCount(channelId), 1);

    const leaves = await storage.getLeaves(channelId);
    assert.strictEqual(leaves.length, 1);
    assert.strictEqual(leaves[0].toString(), 'fake');

    assert.ok(await storage.hasMessage(channelId, fake.hash));
    const getFake = await storage.getMessage(channelId, fake.hash);
    assert.strictEqual(getFake.toString(), 'fake');
  });

  it('should order messages in CRDT order', async () => {
    await storage.addMessage(msg('a', 0));
    await storage.addMessage(msg('c', 1));
    await storage.addMessage(msg('b', 1));
    await storage.addMessage(msg('d', 2));

    assert.strictEqual(await at(0), '0: a');
    assert.strictEqual(await at(1), '1: b');
    assert.strictEqual(await at(2), '1: c');
    assert.strictEqual(await at(3), '2: d');
  });

  it('should query messages by height', async () => {
    await storage.addMessage(msg('a', 0));
    await storage.addMessage(msg('c', 1));
    await storage.addMessage(msg('b', 1));
    await storage.addMessage(msg('d', 2));

    {
      const result = await storage.query(channelId, { height: 1 }, false, 2);
      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(result.messages[0].toString(), '1: b');
      assert.strictEqual(result.messages[1].toString(), '1: c');
      assert.strictEqual(result.backwardHash.toString(), 'b');
      assert.strictEqual(result.forwardHash.toString(), 'd');
    }
  });

  it('should query messages by hash', async () => {
    await storage.addMessage(msg('a', 0));
    await storage.addMessage(msg('c', 1));
    await storage.addMessage(msg('b', 1));
    await storage.addMessage(msg('d', 2));

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('b') },
        false,
        2);
      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(result.messages[0].toString(), '1: b');
      assert.strictEqual(result.messages[1].toString(), '1: c');
      assert.strictEqual(result.backwardHash.toString(), 'b');
      assert.strictEqual(result.forwardHash.toString(), 'd');
    }

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('b') },
        true,
        2);
      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(result.messages[0].toString(), '0: a');
      assert.strictEqual(result.backwardHash, null);
      assert.strictEqual(result.forwardHash.toString(), 'b');
    }

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('d') },
        false,
        2);
      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(result.messages[0].toString(), '2: d');
      assert.strictEqual(result.backwardHash.toString(), 'd');
      assert.strictEqual(result.forwardHash, null);
    }

    {
      const result = await storage.query(
        channelId,
        { hash: Buffer.from('x') },
        false,
        2);
      assert.strictEqual(result.messages.length, 0);
      assert.strictEqual(result.backwardHash, null);
      assert.strictEqual(result.forwardHash, null);
    }
  });

  it('should compute leaves through parent hashes', async () => {
    assert.deepStrictEqual(await leaves(), []);

    await storage.addMessage(msg('a', 0, []));
    assert.deepStrictEqual(await leaves(), [ '0: a' ]);

    await storage.addMessage(msg('c', 1, [ 'a' ]));
    assert.deepStrictEqual(await leaves(), [ '1: c' ]);

    await storage.addMessage(msg('b', 1, [ 'a' ]));
    assert.deepStrictEqual(await leaves(), [ '1: b', '1: c' ]);

    await storage.addMessage(msg('d', 2, [ 'b', 'c' ]));
    assert.deepStrictEqual(await leaves(), [ '2: d' ]);
  });

  it('should store and retrieve entities', async () => {
    class Fake {
      constructor(text) {
        this.text = text;
      }

      serializeData() {
        return Buffer.from(this.text);
      }

      static deserializeData(data) {
        return new Fake(data.toString());
      }
    }

    assert.ok(!await storage.retrieveEntity('fake', 'id', Fake));
    await storage.storeEntity('fake', 'id', new Fake('hello'));

    assert.deepStrictEqual(await storage.getEntityKeys('fake'), [ 'id' ]);

    const blob = await storage.retrieveEntity('fake', 'id', Fake);
    assert.strictEqual(Fake.deserializeData(blob).text, 'hello');

    const missing = await storage.retrieveEntity('fake', randomBytes(32), Fake);
    assert.ok(!missing);
  });
});
