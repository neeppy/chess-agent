<script lang="ts">
	import { pieceUrl } from '#lib/chess-ui.ts';

	interface Props {
		defaultName: string;
		inProgress: boolean;
		onstart: (opts: { humanColor: 'white' | 'black' | 'random'; humanName: string }) => Promise<boolean>;
	}

	let { defaultName, inProgress, onstart }: Props = $props();
	let dialog: HTMLDialogElement;
	let color = $state<'white' | 'black' | 'random'>('white');
	let name = $state('');
	let busy = $state(false);

	export function open() {
		name = defaultName === 'Human' ? '' : defaultName;
		dialog.showModal();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await onstart({ humanColor: color, humanName: name.trim() || 'Human' });
		busy = false;
		if (ok) dialog.close();
	}

	const options = [
		{ value: 'white', label: 'White' },
		{ value: 'random', label: 'Random' },
		{ value: 'black', label: 'Black' }
	] as const;
</script>

<dialog
	bind:this={dialog}
	class="m-auto w-[min(92vw,24rem)] rounded-xl bg-stone-800 p-0 text-stone-100 shadow-2xl backdrop:bg-black/60"
>
	<form class="space-y-5 p-5" onsubmit={submit}>
		<h2 class="text-lg font-semibold">New game</h2>

		<div>
			<p class="mb-2 text-sm text-stone-400">You play</p>
			<div class="grid grid-cols-3 gap-2">
				{#each options as o (o.value)}
					<button
						type="button"
						class="flex flex-col items-center gap-1 rounded-lg border-2 py-2 text-sm {color === o.value
							? 'border-amber-500 bg-stone-700'
							: 'border-transparent bg-stone-900 hover:bg-stone-700'}"
						onclick={() => (color = o.value)}
					>
						{#if o.value === 'random'}
							<span class="flex h-10 items-center rounded-md bg-[#f0d9b5] px-1">
								<img src={pieceUrl('white', 'k')} alt="" class="-mr-3 size-8" />
								<img src={pieceUrl('black', 'k')} alt="" class="size-8" />
							</span>
						{:else}
							<img src={pieceUrl(o.value, 'k')} alt="" class="size-10 rounded-md bg-[#f0d9b5] p-0.5" />
						{/if}
						{o.label}
					</button>
				{/each}
			</div>
		</div>

		<label class="block">
			<span class="mb-1 block text-sm text-stone-400">Your name (for the PGN)</span>
			<input
				bind:value={name}
				placeholder="Human"
				maxlength="40"
				class="w-full rounded-md bg-stone-900 px-3 py-2 outline-none focus:ring-1 focus:ring-amber-500"
			/>
		</label>

		{#if inProgress}
			<p class="rounded-md bg-amber-950/60 px-3 py-2 text-sm text-amber-200">
				The current game is still in progress and will be marked as abandoned.
			</p>
		{/if}

		<div class="flex justify-end gap-2">
			<button type="button" class="rounded-md px-4 py-2 text-sm hover:bg-stone-700" onclick={() => dialog.close()}
				>Cancel</button
			>
			<button class="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold hover:bg-amber-500 disabled:opacity-50" disabled={busy}
				>Start game</button
			>
		</div>
	</form>
</dialog>
