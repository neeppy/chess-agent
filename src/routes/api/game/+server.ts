import { json } from '@sveltejs/kit';
import { game } from '#lib/server/game.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json(game.view());
