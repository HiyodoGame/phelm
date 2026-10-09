#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { PHELM_CONTRACT_VERSION } from '@phelm/contract';

/**
 * Builds the phelm commander program.
 * Exported so tests can inspect the program without triggering argv parsing.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('phelm')
    .description('Task board tracker for ProjectHelm')
    .version(PHELM_CONTRACT_VERSION);

  program
    .command('board')
    .description('Show the current task board')
    .action(() => {
      console.log('not implemented yet');
    });

  return program;
}

const entryPoint = process.argv[1];
const isDirectRun = Boolean(entryPoint) && import.meta.url === pathToFileURL(entryPoint).href;

if (isDirectRun) {
  createProgram().parse();
}
