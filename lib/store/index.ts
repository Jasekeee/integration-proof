// The two reference stores, keyed by the mode in the URL.
import { z } from "zod";
import { STORE_MODES, type StoreMode } from "../db/schema";
import { hardenedStore } from "./hardened";
import { naiveStore } from "./naive";
import type { Store } from "./shared";

export const stores: Record<StoreMode, Store> = { naive: naiveStore, hardened: hardenedStore };

export const StoreModeSchema = z.enum(STORE_MODES);
