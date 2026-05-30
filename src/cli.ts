#!/usr/bin/env node

import { createGreeting } from "./index.ts";

const name = process.argv[2] ?? "TypeScript";

// eslint-disable-next-line no-console
console.log(createGreeting({ name }));
