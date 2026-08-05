#!/usr/bin/env node
import { reportError, run } from './index.js';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.exitCode = reportError(error, (line) => {
    process.stderr.write(`${line}\n`);
  });
}
