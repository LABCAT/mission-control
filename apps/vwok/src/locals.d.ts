/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /**
     * The request named a retired page (PJ-42). Middleware sets it; the catch-all page answers
     * 410 so the status and the rendered page always agree.
     */
    legacyGone?: boolean
  }
}
