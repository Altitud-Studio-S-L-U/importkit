// Type-checks the documentation's TypeScript examples against the built package, and verifies that links to
// files and headings of this repository resolve. Examples that import the package are checked; fragments
// without imports, such as type listings and migration excerpts, are illustrative.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryUrl = 'https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/';
const packageImport = /from '@altitud-studio\/importkit'/u;
const documents = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
  ...readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];

// Application code that the examples call without defining it.
const applicationStubs = `import type { Checkpoint, ImportRecord } from '@altitud-studio/importkit';

declare global {
  interface Order { readonly orderId: string; readonly sku: string; readonly units: number }
  interface Transaction {
    readonly orders: { insertMany(records: readonly ImportRecord<Order>[]): Promise<void> };
    readonly checkpoints: { upsert(importId: string, checkpoint: Checkpoint): Promise<void> };
  }
  function parseOrder(input: unknown): Order;
  function saveOrders(records: readonly ImportRecord<Order>[]): Promise<void>;
  function saveEncodedOrders(records: readonly ImportRecord<string>[]): Promise<void>;
  const db: {
    readonly checkpoints: {
      find(importId: string): Promise<Checkpoint | undefined>;
      upsert(importId: string, checkpoint: Checkpoint): Promise<void>;
    };
    transaction(work: (tx: Transaction) => Promise<void>): Promise<void>;
  };
}
`;

// The subset of the pg client that the PostgreSQL store sketch uses.
const pgStub = `declare module 'pg' {
  export interface QueryResult { readonly rows: any[] }
  export interface PoolClient {
    query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
    release(): void;
  }
  export interface Pool {
    query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
    connect(): Promise<PoolClient>;
  }
}
`;

function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/gu, '-');
}

function headingAnchors(text) {
  const seen = new Map();
  const anchors = new Set();
  for (const match of text.replace(/```[\s\S]*?```/gu, '').matchAll(/^#{1,6}\s+(.+)$/gmu)) {
    const base = slug(match[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

const problems = [];
const examples = [];

for (const document of documents) {
  const text = readFileSync(join(root, document), 'utf8');

  for (const match of text.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/gu)) {
    if (packageImport.test(match[1])) examples.push({ document, code: match[1] });
  }

  for (const match of text.replace(/```[\s\S]*?```/gu, '').matchAll(/\]\(([^)\s]+)\)/gu)) {
    let target = match[1];
    let base = dirname(join(root, document));
    if (target.startsWith(repositoryUrl)) {
      target = target.slice(repositoryUrl.length);
      base = root;
    } else if (/^[a-z][a-z\d+.-]*:/iu.test(target)) {
      continue;
    }
    const [path = '', anchor] = target.split('#');
    const file = path === '' ? join(root, document) : resolve(base, path);
    if (!existsSync(file)) problems.push(`${document}: no file for link ${match[1]}`);
    else if (anchor !== undefined && file.endsWith('.md') && !headingAnchors(readFileSync(file, 'utf8')).has(anchor)) {
      problems.push(`${document}: no heading for link ${match[1]}`);
    }
  }
}

// Inside the package directory, the examples resolve '@altitud-studio/importkit' through its own exports map.
const workDirectory = join(root, '.tmp', 'check-docs');
rmSync(workDirectory, { recursive: true, force: true });
mkdirSync(workDirectory, { recursive: true });
writeFileSync(join(workDirectory, 'application.d.ts'), applicationStubs);
writeFileSync(join(workDirectory, 'pg.d.ts'), pgStub);
examples.forEach(({ code }, index) => writeFileSync(join(workDirectory, `example-${index + 1}.ts`), code));
writeFileSync(join(workDirectory, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
    types: ['node'], typeRoots: [join(root, 'node_modules', '@types')],
  },
  include: ['*.ts'],
}));

const typescript = createRequire(join(root, 'package.json')).resolve('typescript/package.json');
const compilerPath = join(dirname(typescript), JSON.parse(readFileSync(typescript, 'utf8')).bin.tsc);
const compiler = spawnSync(process.execPath, [compilerPath, '-p', workDirectory], { encoding: 'utf8' });
if (compiler.status !== 0) {
  problems.push(`The TypeScript examples do not type-check:\n${compiler.stdout}${compiler.stderr}`.trimEnd());
  examples.forEach(({ document }, index) => problems.push(`  example-${index + 1}.ts comes from ${document}`));
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
rmSync(workDirectory, { recursive: true, force: true });
console.log(`Documentation checked: ${examples.length} TypeScript examples and the links of ${documents.length} files.`);
