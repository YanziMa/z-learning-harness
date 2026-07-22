#!/usr/bin/env node

import { runCli } from './orchestrator-core.mjs';

try {
  const result = await runCli(process.argv.slice(2));
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(`Harness error: ${error.message}`);
  process.exitCode = 1;
}
