<script lang="ts">
	import { lichessUrl } from '#lib/chess-ui.ts';
	import type { GameSummary } from '#lib/types.ts';

	interface Props {
		room: string;
	}

	let { room }: Props = $props();
	let dialog: HTMLDialogElement;
	let games = $state<GameSummary[] | null>(null);

	export async function open() {
		games = null;
		dialog.showModal();
		games = await fetch(`/api/rooms/${room}/games`).then((r) => r.json());
	}

	async function analyze(id: string) {
		// Open the tab synchronously so popup blockers don't interfere.
		const tab = window.open('', '_blank');
		const pgn = await fetch(`/api/rooms/${room}/pgn?game=${id}`).then((r) => r.text());
		if (tab) tab.location.href = lichessUrl(pgn);
	}

	const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<dialog
	bind:this={dialog}
	class="m-auto w-[min(94vw,40rem)] rounded-xl bg-stone-800 p-0 text-stone-100 shadow-2xl backdrop:bg-black/60"
>
	<div class="flex items-center justify-between border-b border-stone-700 px-5 py-3">
		<h2 class="text-lg font-semibold">Games in room {room}</h2>
		<button class="rounded px-2 py-1 text-stone-400 hover:bg-stone-700" onclick={() => dialog.close()}>✕</button>
	</div>
	<div class="max-h-[70vh] overflow-y-auto">
		{#if games === null}
			<p class="px-5 py-4 text-sm text-stone-400">Loading…</p>
		{:else}
			<ul class="divide-y divide-stone-700">
				{#each games as g (g.id)}
					<li class="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
						<div class="min-w-0 flex-1">
							<p class="font-medium">
								{g.white ?? '—'} <span class="text-stone-500">vs</span>
								{g.black ?? '—'}
								{#if g.current}<span class="ml-1 rounded bg-amber-700 px-1.5 text-xs">current</span>{/if}
							</p>
							<p class="text-xs text-stone-400">
								{fmt(g.createdAt)} · {Math.ceil(g.plies / 2)} moves · {g.termination ?? 'In progress'}
							</p>
						</div>
						<span class="font-mono font-semibold">{g.result}</span>
						<a class="text-amber-400 hover:underline" href="/api/rooms/{room}/pgn?game={g.id}&download">PGN</a>
						<button class="text-amber-400 hover:underline" onclick={() => analyze(g.id)}>Analyze</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</dialog>
