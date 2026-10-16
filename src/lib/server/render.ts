import { Resvg } from '@resvg/resvg-js';
import { Chess } from 'chess.js';
import type { Color } from '#lib/types.ts';

// cburnett pieces (same set lichess and the UI use), extracted from chessground's assets.
const pieceFiles = import.meta.glob('../pieces/*.svg', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const PIECES: Record<string, string> = Object.fromEntries(
	Object.entries(pieceFiles).map(([file, svg]) => [
		file.match(/(\w+)\.svg$/)![1], // e.g. "wN"
		svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
	])
);

const LIGHT = '#f0d9b5';
const DARK = '#b58863';
const FILES = 'abcdefgh';

export interface RenderOptions {
	fen: string;
	orientation?: Color;
	lastMove?: { from: string; to: string } | null;
	size?: number;
	coordinates?: boolean;
}

function checkedKingSquare(fen: string): string | null {
	const chess = new Chess(fen);
	if (!chess.inCheck()) return null;
	return chess.findPiece({ type: 'k', color: chess.turn() })[0] ?? null;
}

export function boardSvg({
	fen,
	orientation = 'white',
	lastMove = null,
	size = 480,
	coordinates = true
}: RenderOptions): string {
	const s = size / 8;
	const check = checkedKingSquare(fen);
	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
		`<defs><radialGradient id="check"><stop offset="0%" stop-color="#ff0000"/><stop offset="25%" stop-color="#e70000"/><stop offset="89%" stop-color="#a90000" stop-opacity="0"/><stop offset="100%" stop-color="#9e0000" stop-opacity="0"/></radialGradient></defs>`
	];

	const pos = (file: number, rank: number) =>
		orientation === 'white' ? { x: file * s, y: (7 - rank) * s } : { x: (7 - file) * s, y: rank * s };

	for (let rank = 0; rank < 8; rank++) {
		for (let file = 0; file < 8; file++) {
			const square = FILES[file] + (rank + 1);
			const light = (file + rank) % 2 === 1;
			const { x, y } = pos(file, rank);
			out.push(`<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${light ? LIGHT : DARK}"/>`);
			if (lastMove && (lastMove.from === square || lastMove.to === square))
				out.push(`<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="rgb(155,199,0)" fill-opacity="0.41"/>`);
			if (check === square)
				out.push(`<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="url(#check)"/>`);

			if (!coordinates) continue;
			const label = `font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${(s * 0.2).toFixed(1)}" fill="${light ? DARK : LIGHT}"`;
			const bottomRow = orientation === 'white' ? rank === 0 : rank === 7;
			const leftColumn = orientation === 'white' ? file === 0 : file === 7;
			if (bottomRow)
				out.push(`<text x="${x + s - s * 0.06}" y="${y + s - s * 0.07}" text-anchor="end" ${label}>${FILES[file]}</text>`);
			if (leftColumn)
				out.push(`<text x="${x + s * 0.05}" y="${y + s * 0.22}" ${label}>${rank + 1}</text>`);
		}
	}

	const placement = fen.split(' ')[0].split('/');
	placement.forEach((row, i) => {
		const rank = 7 - i;
		let file = 0;
		for (const ch of row) {
			if (/\d/.test(ch)) {
				file += Number(ch);
				continue;
			}
			const key = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
			const { x, y } = pos(file, rank);
			out.push(`<g transform="translate(${x} ${y}) scale(${s / 45})">${PIECES[key]}</g>`);
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
