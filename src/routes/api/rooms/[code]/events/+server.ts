import { roomOr404 } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/**
 * Server-Sent Events for a room: emits `state` (the full GameView) on connect and after every
 * change. Seated players pass `?as=<playerId>` so the others see them as present.
 */
export const GET: RequestHandler = ({ params, url, request }) => {
	const room = roomOr404(params.code);
	const as = Number(url.searchParams.get('as'));
	const encoder = new TextEncoder();
	let cleanup = () => {};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const write = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const sendState = () => write(`event: state\ndata: ${JSON.stringify(room.view())}\n\n`);

			const unsubscribe = room.subscribe(sendState);
			const disconnect = room.connect(Number.isInteger(as) && as > 0 ? as : null);
			const ping = setInterval(() => write(': ping\n\n'), 15_000);

			cleanup = () => {
				if (closed) return;
				closed = true;
				clearInterval(ping);
				unsubscribe();
				disconnect();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			request.signal.addEventListener('abort', cleanup);
			write('retry: 2000\n\n');
			sendState();
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};
