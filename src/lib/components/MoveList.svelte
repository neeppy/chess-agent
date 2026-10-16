<script lang="ts">
	import type { MoveInfo } from '#lib/types.ts';

	interface Props {
		moves: MoveInfo[];
		/** Ply currently shown on the board. */
		shown: number;
		onselect: (ply: number) => void;
	}

	let { moves, shown, onselect }: Props = $props();
	let scroller: HTMLDivElement;

	const rows = $derived.by(() => {
		const out: ({ n: number } & Partial<Record<MoveInfo['color'], MoveInfo>>)[] = [];
		for (const m of moves) {
			if (m.color === 'white' || !out.length) out.push({ n: m.moveNumber });
			out[out.length - 1][m.color] = m;
		}
		return out;
	});

	// Keep the latest move in view as the game goes on.
	$effect(() => {
		if (shown === moves.length && scroller) scroller.scrollTop = scroller.scrollHeight;
	});
</script>

{#snippet cell(m: MoveInfo | undefined)}
	{#if m}
		<button
			class="rounded px-2 py-0.5 text-left font-medium hover:bg-stone-600 {shown === m.ply
				? 'bg-amber-700/70 text-white'
				: 'text-stone-200'}"
			onclick={() => onselect(m.ply)}>{m.san}</button
		>
	{:else}
		<span></span>
	{/if}
{/snippet}

<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto">
	{#if rows.length === 0}
		<p class="px-3 py-2 text-sm text-stone-500">No moves yet.</p>
	{:else}
		<div class="grid grid-cols-[2.5rem_1fr_1fr] gap-y-0.5 px-1 py-1 font-mono text-sm">
			{#each rows as row (row.n)}
				<span class="py-0.5 pr-1 text-right text-stone-500">{row.n}.</span>
				{@render cell(row.white)}
				{@render cell(row.black)}
			{/each}
		</div>
	{/if}
</div>
