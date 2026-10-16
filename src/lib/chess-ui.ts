import type { Color, LegalMove } from '#lib/types.ts';

const pieceUrls = import.meta.glob('./pieces/*.svg', {
	eager: true,
	query: '?url',
	import: 'default'
}) as Record<string, string>;

/** e.g. pieceUrl('white', 'q') */
export function pieceUrl(color: Color, type: string) {
	return pieceUrls[`./pieces/${color === 'white' ? 'w' : 'b'}${type.toUpperCase()}.svg`];
}

export const other = (c: Color): Color => (c === 'white' ? 'black' : 'white');

export function buildDests(moves: LegalMove[]) {
	const dests = new Map<string, string[]>();
	for (const m of moves) {
		const list = dests.get(m.from) ?? [];
		if (!list.includes(m.to)) list.push(m.to);
		dests.set(m.from, list);
	}
	return dests;
}

const START: Record<string, number> = { q: 1, r: 2, b: 2, n: 2, p: 8 };
const VALUES: Record<string, number> = { q: 9, r: 5, b: 3, n: 3, p: 1 };

/** Pieces each side has captured, and the material balance (positive = white ahead). */
export function captures(fen: string) {
	const counts: Record<Color, Record<string, number>> = {
		white: { q: 0, r: 0, b: 0, n: 0, p: 0 },
		black: { q: 0, r: 0, b: 0, n: 0, p: 0 }
	};
	for (const ch of fen.split(' ')[0]) {
		const type = ch.toLowerCase();
		if (!(type in START)) continue;
		counts[ch === ch.toUpperCase() ? 'white' : 'black'][type]++;
	}
	// Like lichess: show the per-piece material difference (robust to promotions).
	const white: string[] = [];
	const black: string[] = [];
	let balance = 0;
	for (const t of Object.keys(START)) {
		const diff = counts.white[t] - counts.black[t];
		balance += diff * VALUES[t];
		if (diff > 0) white.push(...Array<string>(diff).fill(t));
		if (diff < 0) black.push(...Array<string>(-diff).fill(t));
	}
	return { white, black, balance };
}

/** Movetext without headers, for the lichess analysis link. */
export function lichessUrl(pgn: string) {
	const movetext = pgn
		.split('\n')
		.filter((l) => !l.startsWith('['))
		.join(' ')
		.trim();
	return `https://lichess.org/analysis/pgn/${encodeURIComponent(movetext)}`;
}
