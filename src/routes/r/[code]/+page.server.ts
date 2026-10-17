import { error } from '@sveltejs/kit';
import { rooms } from '#lib/server/rooms.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const room = rooms.get(params.code);
	if (!room) error(404, 'No such room');
	return { initial: room.view() };
};
