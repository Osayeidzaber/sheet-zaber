import { execSync } from "node:child_process"

import pg from "pg"

import { E2E_DATABASE_URL } from "../playwright.config"

/* A throwaway database, migrated by the real deploy script. Needs `pnpm db:local` running. */
export default async function globalSetup(): Promise<void> {
  const admin = new pg.Client(E2E_DATABASE_URL.replace(/\/[^/]+$/, "/postgres"))
  await admin.connect()
  await admin.query("drop database if exists sheet_zaber_e2e with (force)")
  await admin.query("create database sheet_zaber_e2e")
  await admin.end()
  execSync("pnpm db:deploy", { env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL }, stdio: "inherit" })
}
