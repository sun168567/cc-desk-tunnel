#!/usr/bin/env node
import { main } from '../src/main.mjs';

process.exitCode = await main(process.argv.slice(2));
