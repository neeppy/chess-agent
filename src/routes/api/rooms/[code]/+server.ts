import { json } from '@sveltejs/kit';
import { roomOr404 } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => json(roomOr404(params.code).view());
