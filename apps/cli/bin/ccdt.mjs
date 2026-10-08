#!/usr/bin/env node
import { main } from '../src/main.mjs';

// stdin may still hold the event loop after the terminal is restored, so the code is handed over explicitly.
process.exit(await main(process.argv.slice(2)));
