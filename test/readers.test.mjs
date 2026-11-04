import assert from 'node:assert/strict';
import test from 'node:test';
import { csvReader, jsonlReader } from '../dist/index.js';

async function* pieces(input, size = 3) {
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function records(reader, input, { size = 3, maxRecordBytes = 1024 } = {}) {
  return Array.fromAsync(reader.read(pieces(input, size), { maxRecordBytes }));
}

async function read(reader, input, options) {
  return (await records(reader, input, options)).map((record) => record.value);
}

test('CSV preserves quoted delimiters, quotes, multiline text, CRLF, BOM, and split UTF-8', async () => {
  const records = await read(csvReader(), '\uFEFFid,note\r\n1,"Café, \"\"sí\"\"\nnext"\r\n2,plain', { size: 1 });
  assert.deepEqual(records.map((record) => ({ ...record })), [{ id: '1', note: 'Café, "sí"\nnext' }, { id: '2', note: 'plain' }]);
  assert.equal(Object.getPrototypeOf(records[0]), null);
});

test('CSV supports a declared delimiter and stable reader identity', async () => {
  assert.equal(csvReader().id, csvReader({ delimiter: ',' }).id);
  assert.notEqual(csvReader().id, csvReader({ delimiter: ';' }).id);
  assert.deepEqual((await read(csvReader({ delimiter: ';' }), 'id;name\n1;one\n')).map((value) => ({ ...value })), [{ id: '1', name: 'one' }]);
});

test('CSV empty input and a header-only file contain no records', async () => {
  assert.deepEqual(await read(csvReader(), ''), []);
  assert.deepEqual(await read(csvReader(), 'id,name\n'), []);
});

test('CSV rejects malformed input and invalid or dangerous headers', async () => {
  for (const input of ['id,id\n1,2', 'id,\n1,2', 'id, \n1,2', '__proto__\nx', 'constructor\nx', 'prototype\nx', 'id,name\n1', 'id\n"unclosed', 'id\n"x"oops']) {
    await assert.rejects(read(csvReader(), input), { code: 'PARSE_ERROR' });
  }
});

test('CSV rejects invalid UTF-8 without exposing values in its error', async () => {
  await assert.rejects(read(csvReader(), Buffer.from([0x69, 0x64, 0x0a, 0xc3, 0x28])), (error) => error.code === 'PARSE_ERROR' && !error.message.includes('('));
  await assert.rejects(read(csvReader(), 'id\n"private-value"extra'), (error) => error.code === 'PARSE_ERROR' && !error.message.includes('private-value'));
});

test('CSV enforces serialized bytes, including quotes, delimiters and terminators', async () => {
  assert.deepEqual((await read(csvReader(), 'a,b\n1,2\n', { maxRecordBytes: 4, size: 1 })).map((value) => ({ ...value })), [{ a: '1', b: '2' }]);
  await assert.rejects(read(csvReader(), 'a,b\n1,é\n', { maxRecordBytes: 4, size: 1 }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(read(csvReader(), 'a,b\n"",""\n', { maxRecordBytes: 5 }), { code: 'LIMIT_EXCEEDED' });
});

test('CSV stops an unbounded record of empty fields before consuming the source', async () => {
  let supplied = 0;
  async function* source() {
    while (supplied < 1000) {
      supplied++;
      yield Buffer.from(',');
    }
  }
  await assert.rejects(Array.fromAsync(csvReader().read(source(), { maxRecordBytes: 16 })), { code: 'LIMIT_EXCEEDED' });
  assert.ok(supplied <= 20, 'a rejected record may consume four bytes of parser lookahead');
});

test('CSV handles many records per chunk without deadlock', async () => {
  const result = await read(csvReader(), `id\n${Array.from({ length: 500 }, (_, index) => `${index}\n`).join('')}`, { size: 8192 });
  assert.equal(result.length, 500);
  assert.equal(result[499].id, '499');
});

test('CSV byte limits remain exact at chunk and record boundaries', async () => {
  for (const ending of ['\n', '\r\n', '\r', '']) {
    const last = `"Café","a,b"${ending}`;
    const header = `name,note${ending || '\n'}`;
    const input = `${header}${last}`;
    const exactLimit = Math.max(Buffer.byteLength(header), Buffer.byteLength(last));
    for (const size of [1, 2, 3, 4, 7, 64]) {
      const values = await read(csvReader(), input, { size, maxRecordBytes: exactLimit });
      assert.deepEqual(values.map((value) => ({ ...value })), [{ name: 'Café', note: 'a,b' }]);
      await assert.rejects(read(csvReader(), input, { size, maxRecordBytes: exactLimit - 1 }), { code: 'LIMIT_EXCEEDED' });
    }
  }
});

test('JSON Lines accepts objects, primitives, null, CRLF, BOM and final unterminated line', async () => {
  assert.deepEqual(await read(jsonlReader(), '\uFEFF{"name":"Café"}\r\nnull\n42\n"text"\ntrue', { size: 1 }), [{ name: 'Café' }, null, 42, 'text', true]);
  assert.deepEqual(await read(jsonlReader(), ''), []);
});

test('JSON Lines rejects blank lines, malformed input, a noninitial BOM and invalid UTF-8', async () => {
  for (const input of ['\n', '{}\n\n', '  \n', '{"secret":\n', '{}\n\uFEFF{}']) {
    await assert.rejects(read(jsonlReader(), input), { code: 'PARSE_ERROR' });
  }
  await assert.rejects(read(jsonlReader(), Buffer.from([0x22, 0xc3, 0x28, 0x22])), { code: 'PARSE_ERROR' });
  await assert.rejects(read(jsonlReader(), '"private-value"oops'), (error) => error.code === 'PARSE_ERROR' && !error.message.includes('private-value'));
});

test('JSON Lines enforces serialized UTF-8 bytes across chunks', async () => {
  assert.deepEqual(await read(jsonlReader(), '"é"\n', { maxRecordBytes: 5, size: 1 }), ['é']);
  await assert.rejects(read(jsonlReader(), '"é"\n', { maxRecordBytes: 4, size: 1 }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(read(jsonlReader(), '"longer"', { maxRecordBytes: 4, size: 1 }), { code: 'LIMIT_EXCEEDED' });
});

test('readers validate their options', async () => {
  for (const delimiter of ['', '||', 'é', '\n', '"', '\0']) assert.throws(() => csvReader({ delimiter }), { code: 'INVALID_OPTIONS' });
  for (const reader of [csvReader(), jsonlReader()]) {
    for (const maxRecordBytes of [0, -1, NaN, Infinity, 1.5]) {
      await assert.rejects(read(reader, '', { maxRecordBytes }), { code: 'INVALID_OPTIONS' });
    }
  }
});

test('CSV reader closes its input when the consumer stops early', async () => {
  let closed = false;
  async function* source() {
    try {
      for (let index = 0; index < 100; index++) yield Buffer.from(index === 0 ? 'id\n0\n' : `${index}\n`);
    } finally {
      closed = true;
    }
  }
  for await (const _record of csvReader().read(source(), { maxRecordBytes: 32 })) break;
  assert.equal(closed, true);
});

test('readers report the line where each record starts, counting line breaks inside quoted fields', async () => {
  const crlf = await records(csvReader(), '\uFEFFid,note\r\n1,"two\r\nlines"\r\n2,b\r\n', { size: 2 });
  assert.deepEqual(crlf.map(({ line }) => line), [2, 4]);
  const lf = await records(csvReader(), 'id,note\n1,a\n2,"x\ny\nz"\n3,last', { size: 2 });
  assert.deepEqual(lf.map(({ line }) => line), [2, 3, 6]);
  const jsonl = await records(jsonlReader(), '\uFEFF1\r\n2\n3', { size: 1 });
  assert.deepEqual(jsonl.map(({ value, line }) => [value, line]), [[1, 1], [2, 2], [3, 3]]);
});

test('reader errors report the line where the failing record starts', async () => {
  await assert.rejects(read(csvReader(), 'id,id\n1,2\n'), { code: 'PARSE_ERROR', line: 1 });
  await assert.rejects(read(csvReader(), 'id,note\n1,a\n2\n'), { code: 'PARSE_ERROR', line: 3 });
  await assert.rejects(read(csvReader(), 'id,note\n1,"a\nb"\n2,"open\nstill open'), { code: 'PARSE_ERROR', line: 4 });
  await assert.rejects(read(csvReader(), 'id\n1\n12345\n', { maxRecordBytes: 4 }), { code: 'LIMIT_EXCEEDED', line: 3 });
  await assert.rejects(read(jsonlReader(), '1\n2\n{oops\n'), { code: 'PARSE_ERROR', line: 3 });
  await assert.rejects(read(jsonlReader(), '1\n\n'), { code: 'PARSE_ERROR', line: 2 });
  await assert.rejects(read(jsonlReader(), '1\n"long"\n', { maxRecordBytes: 4 }), { code: 'LIMIT_EXCEEDED', line: 2 });
});

test('CSV reader settles when its consumer stops while parsed rows are buffered', { timeout: 10_000 }, async () => {
  const rows = (header) => [header, ...Array.from({ length: 40 }, (_, index) => `${index},${index}`)].join('\n');
  await assert.rejects(read(csvReader(), rows('id,id'), { size: 65_536 }), { code: 'PARSE_ERROR', line: 1 });
  let seen = 0;
  for await (const _record of csvReader().read(pieces(rows('id,name'), 65_536), { maxRecordBytes: 64 })) {
    seen++;
    break;
  }
  assert.equal(seen, 1);
});
