<script lang="ts">
	import { pieceUrl } from '#lib/chess-ui.ts';
	import type { Color } from '#lib/types.ts';

	interface Props {
		color: Color;
		onpick: (piece: string) => void;
		oncancel: () => void;
	}

	let { color, onpick, oncancel }: Props = $props();
	const pieces = ['q', 'r', 'b', 'n'];
	const names: Record<string, string> = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />

<div
	class="absolute inset-0 z-20 flex items-center justify-center bg-black/55"
	role="presentation"
	onclick={oncancel}
>
	<div class="rounded-lg bg-stone-800 p-3 shadow-2xl" role="dialog" aria-label="Choose promotion piece">
		<p class="mb-2 text-center text-sm text-stone-300">Promote to</p>
		<div class="flex gap-2">
			{#each pieces as p (p)}
				<button
					class="rounded-md bg-stone-700 p-1.5 hover:bg-amber-600"
					title={names[p]}
					onclick={(e) => {
						e.stopPropagation();
						onpick(p);
					}}
				>
					<img src={pieceUrl(color, p)} alt={names[p]} class="size-14" />
				</button>
			{/each}
		</div>
	</div>
</div>
