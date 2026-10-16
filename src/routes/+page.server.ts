import { game } from '#lib/server/game.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ initial: game.view() });
