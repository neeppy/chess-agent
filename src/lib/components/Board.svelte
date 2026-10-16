<script lang="ts">
	import { onMount } from 'svelte';
	import { Chessground } from '@lichess-org/chessground';
	import type { Api } from '@lichess-org/chessground/api';
	import type { Key } from '@lichess-org/chessground/types';
	import '@lichess-org/chessground/assets/chessground.base.css';
	import '@lichess-org/chessground/assets/chessground.brown.css';
	import '@lichess-org/chessground/assets/chessground.cburnett.css';
	import type { Color } from '#lib/types.ts';

	interface Props {
		fen: string;
		orientation: Color;
		turnColor: Color;
		lastMove?: [string, string] | null;
		check?: boolean;
		/** Color the user may move right now (undefined = nobody). */
		movableColor?: Color;
		dests?: Map<string, string[]>;
		onmove?: (from: string, to: string) => void;
	}

	let {
		fen,
		orientation,
		turnColor,
		lastMove = null,
		check = false,
		movableColor,
		dests = new Map(),
		onmove
	}: Props = $props();

	let el: HTMLDivElement;
	let cg: Api | undefined;

	function config() {
		return {
			fen,
			orientation,
			turnColor,
			lastMove: (lastMove ?? undefined) as Key[] | undefined,
			check: check ? turnColor : false,
			movable: {
				free: false,
				color: movableColor,
				dests: dests as Map<Key, Key[]>,
				showDests: true
			}
		};
	}

	onMount(() => {
		cg = Chessground(el, {
			...config(),
			coordinates: true,
			animation: { enabled: true, duration: 200 },
			highlight: { lastMove: true, check: true },
			premovable: { enabled: false },
			drawable: { enabled: true },
			movable: {
				...config().movable,
				events: { after: (from, to) => onmove?.(from, to) }
			}
		});
		return () => cg?.destroy();
	});

	// Re-sync the board whenever the inputs change (also undoes rejected optimistic moves).
	$effect(() => {
		const c = config();
		cg?.set(c);
	});

	/** Force the board back to the given props (e.g. after a cancelled promotion). */
	export function reset() {
		cg?.set(config());
	}
</script>

<div bind:this={el} class="board"></div>

<style>
	.board {
		width: 100%;
		height: 100%;
	}
	/* Coordinates: smaller and tucked into the squares like on lichess. */
	.board :global(coords) {
		font-size: clamp(8px, 1.6vmin, 12px);
		font-weight: 700;
	}
</style>
