#!/usr/bin/env bun
/**
 * clwnd MCP server — stdio transport (fallback).
 * The daemon normally serves MCP via HTTP. This is used only if
 * stdio transport is needed.
 */

import { createInterface } from "readline";
import { loadPermissionsFromFile, handleMcpRequest } from "./tools.ts";

loadPermissionsFromFile();

const rl = createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  try {
    const result = handleMcpRequest(JSON.parse(line));
    if (result) process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e: any) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: `Parse error: ${e.message}` } }) + "\n");
  }
});
rl.on("close", () => process.exit(0));
