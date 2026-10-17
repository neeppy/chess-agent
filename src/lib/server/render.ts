import { Resvg } from '@resvg/resvg-js';
import { Chess } from 'chess.js';
import type { Color } from '#lib/types.ts';

// The same piece set the UI uses (staunty). Embedded as images rather than inlined, so each
// piece keeps its own viewBox and styles whatever set is in ../pieces.
const pieceFiles = import.meta.glob('../pieces/*.svg', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const PIECES: Record<string, string> = Object.fromEntries(
	Object.entries(pieceFiles).map(([file, svg]) => [
		file.match(/(\w+)\.svg$/)![1], // e.g. "wN"
		`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
	])
);

// Matches the web UI: chessground's brown theme, where dark squares are the light colour under
// a 20% black overlay, inside the walnut frame that carries the rank and file labels.
const LIGHT = '#f0d9b5';
const DARK_OVERLAY = 0.2;
const FRAME = '#5a4130';
const LABEL = '#d2bb9a'; // the UI's labels: the light square colour at 80% over the frame
const LABEL_MARKED = '#fcd34d'; // the last move's file and rank
const FILES = 'abcdefgh';

export interface RenderOptions {
	fen: string;
	orientation?: Color;
	lastMove?: { from: string; to: string } | null;
	/** Width and height of the whole image, frame included. */
	size?: number;
}

function checkedKingSquare(fen: string): string | null {
	const chess = new Chess(fen);
	if (!chess.inCheck()) return null;
	return chess.findPiece({ type: 'k', color: chess.turn() })[0] ?? null;
}

export function boardSvg({ fen, orientation = 'white', lastMove = null, size = 480 }: RenderOptions): string {
	const frame = Math.round(size * 0.05);
	const s = (size - 2 * frame) / 8;
	const check = checkedKingSquare(fen);
	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
		`<defs><radialGradient id="check"><stop offset="0%" stop-color="#ff0000"/><stop offset="25%" stop-color="#e70000"/><stop offset="89%" stop-color="#a90000" stop-opacity="0"/><stop offset="100%" stop-color="#9e0000" stop-opacity="0"/></radialGradient></defs>`,
		`<rect width="${size}" height="${size}" rx="${(frame * 0.3).toFixed(1)}" fill="${FRAME}"/>`
	];

	const pos = (file: number, rank: number) =>
		orientation === 'white'
			? { x: frame + file * s, y: frame + (7 - rank) * s }
			: { x: frame + (7 - file) * s, y: frame + rank * s };
	const square = (x: number, y: number, fill: string, opacity = 1) =>
		`<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}/>`;

	for (let rank = 0; rank < 8; rank++) {
		for (let file = 0; file < 8; file++) {
			const name = FILES[file] + (rank + 1);
			const { x, y } = pos(file, rank);
			out.push(square(x, y, LIGHT));
			if ((file + rank) % 2 === 0) out.push(square(x, y, '#000', DARK_OVERLAY));
			if (lastMove && (lastMove.from === name || lastMove.to === name)) out.push(square(x, y, 'rgb(155,199,0)', 0.41));
			if (check === name) out.push(square(x, y, 'url(#check)'));
		}
	}

	// Rank numbers down the left of the frame, file letters along the bottom, as the viewer sees them.
	const font = frame * 0.55;
	const lift = font * 0.36; // drop the baseline so digits and letters sit centred
	const label = (text: string, x: number, y: number, marked: boolean) =>
		`<text x="${x.toFixed(1)}" y="${(y + lift).toFixed(1)}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${font.toFixed(1)}" fill="${marked ? LABEL_MARKED : LABEL}">${text}</text>`;
	for (let i = 0; i < 8; i++) {
		const rank = String(orientation === 'white' ? 8 - i : i + 1);
		const file = orientation === 'white' ? FILES[i] : FILES[7 - i];
		out.push(label(rank, frame / 2, frame + (i + 0.5) * s, lastMove?.to[1] === rank));
		out.push(label(file, frame + (i + 0.5) * s, size - frame / 2, lastMove?.to[0] === file));
	}

	fen
		.split(' ')[0]
		.split('/')
		.forEach((row, i) => {
			const rank = 7 - i;
			let file = 0;
			for (const ch of row) {
				if (/\d/.test(ch)) {
					file += Number(ch);
					continue;
				}
				const key = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
				const { x, y } = pos(file, rank);
				out.push(`<image x="${x}" y="${y}" width="${s}" height="${s}" href="${PIECES[key]}"/>`);
				file++;
			}
		});

	out.push('</svg>');
	return out.join('');
}

export function boardPng(options: RenderOptions): Buffer {
	const svg = boardSvg(options);
	const resvg = new Resvg(svg, {
		font: {
			loadSystemFonts: true,
			// System font discovery needs fontconfig, which slim containers lack; scan the usual
			// directories explicitly too (the Docker image installs DejaVu there).
			fontDirs: ['/usr/share/fonts', '/usr/local/share/fonts'],
			defaultFontFamily: 'DejaVu Sans'
		}
	});
	return resvg.render().asPng();
}
