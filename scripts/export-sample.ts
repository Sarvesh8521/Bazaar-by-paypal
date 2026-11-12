import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mockLlm } from '../server/agents.ts';
import { buildSampleExport, createSession, listPublicListings, loadStore, runSession, seedListings } from '../server/sessions.ts';

/**
 * Package a finished haggle as public/sample-crawl.json so the "Watch a recorded crawl" page works for anyone.
 *   npm run sample -- <sessionId>   a real run from data/store.json (do this after a real haggle; label comes from the run)
 *   npm run sample -- --mock        a run with the offline demo agents (clearly labelled "not real AI")
 */
const arg = process.argv[2];
const out = path.resolve('public/sample-crawl.json');

async function main() {
  let id = arg;
  if (arg === '--mock') {
    seedListings();
    const row = listPublicListings().filter((l) => l.category === 'headphones');
    const s = await createSession({ listingIds: row.map((l) => l.id), maxBudget: 140, buyerPersona: 'dramatic' }, { pay: null, baseUrl: 'http://localhost', searchMarket: async () => [] });
    for await (const _ of runSession(s.id, { llm: mockLlm, pay: null, aiMode: 'mock' })) void _;
    id = s.id;
  } else {
    const file = process.env.DATA_FILE ?? path.resolve('data/store.json');
    if (!loadStore(file)) throw new Error(`Could not read ${file}. Run a haggle first, or use --mock.`);
    if (!id) throw new Error('Give a session id: npm run sample -- <sessionId>   (find it in the #/arena/<id> address)');
  }
  const sample = buildSampleExport(id!);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(sample, null, 2));
  console.log(`Wrote ${out}\n  recorded with: ${sample.ai}  | stalls: ${sample.view.items.length}  | winner price: ${sample.view.crawl?.winner?.price ?? 'none'}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
