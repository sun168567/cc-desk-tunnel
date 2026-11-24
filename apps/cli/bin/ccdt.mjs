#!/usr/bin/env node
import { main } from '../src/main.mjs';
import { argumentsAsWritten } from '../src/runtime.mjs';

argumentsAsWritten();
process.exitCode = await main(process.argv.slice(2));
