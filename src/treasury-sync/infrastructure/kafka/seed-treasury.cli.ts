import { Kafka } from 'kafkajs';

import { parseMessage } from './message-dispatch';
import { TREASURY_TOPIC } from './treasury-kafka-consumer';
import { SEED_PROGRAMS } from '../../../capacity/infrastructure/persistence/seed';
import { loadTreasurySeedEnv } from '../../../shared/config/env.schema';
import { type InvoiceRepaidMessage } from '../messages/invoice-repaid.message';
import { type ProgramSnapshotMessage } from '../messages/program-snapshot.message';

/** The seeded program `seed.ts` gives head-room to (docs/PLAN.md 2.2, 2.9). */
const SEED_PROGRAM_ID = 'prog-usd-northwind';

/** Hosts a broker list may point at without being told: loopback, or the compose service name. */
const LOCAL_HOSTS = ['localhost', '::1', 'redpanda'];

/**
 * The host of a broker address (`host:port`, no scheme), or `null` if it does
 * not parse. Duplicated from `seed.cli.ts`'s own `hostOf` rather than shared:
 * that one parses a `postgres://` connection string, this one a bare
 * `host:port` pair, and the ten-line guard is cheaper to read twice than to
 * generalise into one function that parses neither shape especially well.
 */
function hostOf(brokerAddress: string): string | null {
  try {
    return new URL(`kafka://${brokerAddress}`).hostname.replace(/^\[|]$/g, '');
  } catch {
    return null;
  }
}

/** Whether these brokers may be published to: an explicit `SEED_ALLOW=1`, or every host local by construction. */
function mayBeSeeded(
  hosts: readonly (string | null)[],
  seedAllow: string | undefined,
): boolean {
  if (seedAllow === '1') {
    return true;
  }

  return hosts.every(
    (host) =>
      host !== null && (LOCAL_HOSTS.includes(host) || host.startsWith('127.')),
  );
}

function buildSnapshotMessage(
  programId: string,
  currency: string,
  creditLimit: string,
  invoiceId: string,
  amount: string,
): ProgramSnapshotMessage {
  return {
    type: 'ProgramSnapshot',
    programId,
    currency,
    // Seconds since epoch: monotonic across runs, so re-running this script
    // an hour apart is never rejected as `STALE_SEQUENCE` against whatever a
    // previous run already advanced the watermark to.
    sequence: Math.floor(Date.now() / 1000),
    asOf: new Date().toISOString(),
    creditLimit,
    invoices: [
      {
        invoiceId,
        status: 'OUTSTANDING',
        amount,
        originalAmount: amount,
        originalCurrency: currency,
      },
    ],
    outstandingTotal: amount,
    invoiceCount: 1,
    repaidTotal: '0.00',
    repaidCount: 0,
  };
}

/** `npm run seed:treasury`. Publishes two sample messages; exits non-zero with the error on stderr. */
async function main(): Promise<void> {
  const env = loadTreasurySeedEnv();
  const hosts = env.KAFKA_BROKERS.map(hostOf);

  // Guarded because a published message cannot be unpublished: the consumer
  // on the other end applies it the moment it is read (docs/PLAN.md 2.9).
  if (!mayBeSeeded(hosts, env.SEED_ALLOW)) {
    throw new Error(
      `refusing to publish to ${env.KAFKA_BROKERS.join(', ')}: none of its hosts are a loopback address or the compose service name, and a treasury message is applied as soon as a real consumer reads it. If these brokers really may be seeded, run the command again with SEED_ALLOW=1. This is a guard against a mistake and not a security control.`,
    );
  }

  const program = SEED_PROGRAMS.find(
    (candidate) => candidate.id === SEED_PROGRAM_ID,
  );

  if (program === undefined) {
    throw new Error(
      `seed program ${SEED_PROGRAM_ID} not found in SEED_PROGRAMS`,
    );
  }

  const hold = program.holds[0];

  if (hold === undefined) {
    throw new Error(`seed program ${SEED_PROGRAM_ID} has no holds to repay`);
  }

  if (hold.currency !== program.currency) {
    throw new Error(
      `seed program ${SEED_PROGRAM_ID}'s first hold is in ${hold.currency}, not its own ${program.currency} — this script only builds an unconverted snapshot entry`,
    );
  }

  const snapshot = buildSnapshotMessage(
    program.id,
    program.currency,
    program.creditLimit,
    hold.invoiceId,
    hold.amount,
  );
  const repaid: InvoiceRepaidMessage = {
    type: 'InvoiceRepaid',
    programId: program.id,
    invoiceId: hold.invoiceId,
  };

  // Fails loudly, before anything is published, if either message would not
  // pass the real consumer's own parse-then-validate step.
  parseMessage(JSON.stringify(snapshot));
  parseMessage(JSON.stringify(repaid));

  const kafka = new Kafka({
    brokers: env.KAFKA_BROKERS,
    clientId: 'program-capacity-seed',
  });
  const producer = kafka.producer();

  await producer.connect();

  try {
    await producer.send({
      topic: TREASURY_TOPIC,
      messages: [
        { key: program.id, value: JSON.stringify(snapshot) },
        { key: program.id, value: JSON.stringify(repaid) },
      ],
    });

    console.log(
      `seed:treasury: published ProgramSnapshot (sequence ${snapshot.sequence}) and InvoiceRepaid for ${program.id}/${hold.invoiceId} to ${TREASURY_TOPIC}`,
    );
  } finally {
    await producer.disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
