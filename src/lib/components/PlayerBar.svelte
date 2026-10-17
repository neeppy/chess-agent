<script lang="ts">
	import { pieceUrl } from '#lib/chess-ui.ts';
	import type { Color, SeatView } from '#lib/types.ts';

	interface Props {
		color: Color;
		seat: SeatView | null;
		/** Piece types this side is ahead by. */
		captured: string[];
		/** Material lead in points (only shown when positive). */
		lead: number;
		/** This side is to move. */
		active: boolean;
		/** This browser holds the seat. */
		you: boolean;
		badge?: { text: string; tone: 'on' | 'off' | 'busy' } | null;
		/** Offered when the seat is empty and can be taken. */
		ontake?: (() => void) | null;
		/** Offered when the seat is occupied by someone else and can be taken over. */
		ontakeover?: (() => void) | null;
	}

	let { color, seat, captured, lead, active, you, badge = null, ontake = null, ontakeover = null }: Props = $props();
	const opponent: Color = $derived(color === 'white' ? 'black' : 'white');
</script>

<div
	class="flex h-11 items-center gap-3 rounded-md px-3 transition-colors {active ? 'bg-stone-700/70' : 'bg-stone-800/50'}"
>
	<span class="size-3.5 shrink-0 rounded-full ring-1 ring-stone-500 {color === 'white' ? 'bg-stone-100' : 'bg-stone-950'}"></span>
	{#if seat}
		<span class="truncate font-semibold text-stone-100">{seat.name}</span>
		{#if seat.kind === 'agent'}<span class="rounded bg-sky-900 px-1.5 text-[10px] font-semibold tracking-wide text-sky-200">AI</span>{/if}
		{#if you}<span class="text-xs text-stone-400">(you)</span>{/if}
	{:else}
		<span class="text-stone-500 italic">Empty seat</span>
	{/if}
	<span class="flex min-w-0 items-center">
		{#each captured as type, i (i)}
			<img src={pieceUrl(opponent, type)} alt={type} class="-mr-1.5 size-5 first:ml-0" />
		{/each}
		{#if lead > 0}<span class="ml-2.5 text-xs font-medium text-stone-400">+{lead}</span>{/if}
	</span>
	{#if !seat && ontake}
		<button class="ml-auto rounded-md bg-amber-600 px-3 py-1 text-sm font-semibold hover:bg-amber-500" onclick={ontake}
			>Take seat</button
		>
	{:else if badge}
		<span class="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-stone-300">
			<span
				class="size-2 rounded-full {badge.tone === 'on'
					? 'bg-emerald-400'
					: badge.tone === 'busy'
						? 'animate-pulse bg-amber-400'
						: 'bg-stone-500'}"
			></span>
			{badge.text}
		</span>
	{/if}
	{#if seat && ontakeover}
		<button
			class="{badge ? '' : 'ml-auto'} shrink-0 rounded-md px-2 py-0.5 text-xs text-stone-400 ring-1 ring-stone-600 hover:bg-stone-700 hover:text-stone-200"
			onclick={ontakeover}>Take over</button
		>
	{/if}
</div>
