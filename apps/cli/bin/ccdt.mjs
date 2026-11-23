#!/usr/bin/env node
// First, before anything reads the process's input or environment.
import '../src/console.mjs';
import { main } from '../src/main.mjs';

process.exitCode = await main(process.argv.slice(2));
