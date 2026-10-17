<script lang="ts">
	import { pieceUrl } from '#lib/chess-ui.ts';
	import { savedName, saveName } from '#lib/seats.ts';
	import type { Color } from '#lib/types.ts';

	interface Props {
		ontake: (color: Color, name: string) => Promise<boolean>;
	}

	let { ontake }: Props = $props();
	let dialog: HTMLDialogElement;
	let color = $state<Color>('white');
	/** Who holds the seat now, when taking it over. */
	let holder = $state<string | null>(null);
	let name = $state('');
	let busy = $state(false);

	export function open(seat: Color, current: string | null = null) {
		color = seat;
		holder = current;
		name = savedName();
		dialog.showModal();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const chosen = name.trim() || 'Guest';
		saveName(chosen);
		const ok = await ontake(color, chosen);
		busy = false;
		if (ok) dialog.close();
	}
</script>

<dialog
	bind:this={dialog}
	class="m-auto w-[min(92vw,22rem)] rounded-xl bg-stone-800 p-0 text-stone-100 shadow-2xl backdrop:bg-black/60"
>
	<form class="space-y-5 p-5" onsubmit={submit}>
		<div class="flex items-center gap-3">
			<img src={pieceUrl(color, 'k')} alt="" class="size-10 rounded-md bg-[#f0d9b5] p-0.5" />
			<h2 class="text-lg font-semibold">
				{holder ? `Take over ${color === 'white' ? 'White' : 'Black'} from ${holder}` : `Play ${color === 'white' ? 'White' : 'Black'}`}
			</h2>
		</div>
		<label class="block">
			<span class="mb-1 block text-sm text-stone-400">Your name</span>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				bind:value={name}
				placeholder="Guest"
				maxlength="40"
				autofocus
				class="w-full rounded-md bg-stone-900 px-3 py-2 outline-none focus:ring-1 focus:ring-amber-500"
			/>
		</label>
		{#if holder}
			<p class="text-xs text-amber-300">{holder} loses the seat, and you continue their game from the current position.</p>
		{/if}
		<p class="text-xs text-stone-400">This browser keeps the seat: come back to the same link to continue.</p>
		<div class="flex justify-end gap-2">
			<button type="button" class="rounded-md px-4 py-2 text-sm hover:bg-stone-700" onclick={() => dialog.close()}>Cancel</button>
			<button class="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold hover:bg-amber-500 disabled:opacity-50" disabled={busy}
				>{holder ? 'Take over' : 'Take seat'}</button
			>
		</div>
	</form>
</dialog>
