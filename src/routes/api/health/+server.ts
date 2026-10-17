import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** For the container healthcheck (and anything else that wants to know the app is up). */
export const GET: RequestHandler = () => json({ ok: true });
