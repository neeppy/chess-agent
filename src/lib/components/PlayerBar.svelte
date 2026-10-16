<script lang="ts">
	import { pieceUrl } from '#lib/chess-ui.ts';
	import type { Color } from '#lib/types.ts';

	interface Props {
		name: string;
		color: Color;
		/** Piece types this player has captured. */
		captured: string[];
		/** Material lead in points (only shown when positive). */
		lead: number;
		active: boolean;
		badge?: { text: string; tone: 'on' | 'off' | 'busy' } | null;
		label?: string;
	}

	let { name, color, captured, lead, active, badge = null, label }: Props = $props();
	const opponent: Color = $derived(color === 'white' ? 'black' : 'white');
</script>

<div
	class="flex h-11 items-center gap-3 rounded-md px-3 transition-colors {active
		? 'bg-stone-700/70'
		: 'bg-stone-800/50'}"
>
	<span
		class="size-3.5 shrink-0 rounded-full ring-1 ring-stone-500 {color === 'white'
			? 'bg-stone-100'
			: 'bg-stone-950'}"
	></span>
	<span class="truncate font-semibold text-stone-100">{name}</span>
	{#if label}<span class="text-xs text-stone-400">{label}</span>{/if}
	<span class="flex min-w-0 items-center">
		{#each captured as type, i (i)}
			<img src={pieceUrl(opponent, type)} alt={type} class="-mr-1.5 size-5 first:ml-0" />
		{/each}
		{#if lead > 0}<span class="ml-2.5 text-xs font-medium text-stone-400">+{lead}</span>{/if}
	</span>
	{#if badge}
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
</div>
