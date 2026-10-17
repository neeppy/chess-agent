<script lang="ts">
	import type { ChatMessage } from '#lib/types.ts';

	interface Props {
		messages: ChatMessage[];
		/** Players this browser is (or was): their messages are shown as "mine". */
		myPlayerIds: number[];
		/** My messages up to this id have been read by an agent opponent ("seen"). */
		seenUpTo: number;
		canSend: boolean;
		onsend: (text: string) => Promise<boolean>;
	}

	let { messages, myPlayerIds, seenUpTo, canSend, onsend }: Props = $props();
	let draft = $state('');
	let sending = $state(false);
	let scroller: HTMLDivElement;

	$effect(() => {
		void messages.length;
		if (scroller) scroller.scrollTop = scroller.scrollHeight;
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const text = draft.trim();
		if (!text || sending) return;
		sending = true;
		if (await onsend(text)) draft = '';
		sending = false;
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div bind:this={scroller} class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 text-sm">
		{#each messages as m (m.id)}
			{#if m.playerId === null}
				<p class="text-center text-xs text-stone-500">{m.text}</p>
			{:else if myPlayerIds.includes(m.playerId)}
				<div class="ml-auto max-w-[85%] text-right">
					<p class="inline-block rounded-lg rounded-tr-none bg-sky-800 px-2.5 py-1.5 text-left whitespace-pre-wrap text-stone-100">
						{m.text}
					</p>
					{#if m.id <= seenUpTo}<span class="block text-[10px] text-stone-500">seen</span>{/if}
				</div>
			{:else}
				<div class="max-w-[85%]">
					<span class="text-xs font-semibold text-amber-400">{m.name}</span>
					<p class="rounded-lg rounded-tl-none bg-stone-700 px-2.5 py-1.5 whitespace-pre-wrap text-stone-100">{m.text}</p>
				</div>
			{/if}
		{:else}
			<p class="text-stone-500">No messages yet.</p>
		{/each}
	</div>
	{#if canSend}
		<form class="flex gap-2 border-t border-stone-700 p-2" onsubmit={submit}>
			<input
				bind:value={draft}
				placeholder="Message…"
				maxlength="2000"
				class="min-w-0 flex-1 rounded-md bg-stone-900 px-2.5 py-1.5 text-sm text-stone-100 placeholder-stone-500 outline-none focus:ring-1 focus:ring-amber-500"
			/>
			<button
				class="rounded-md bg-stone-700 px-3 text-sm text-stone-100 hover:bg-stone-600 disabled:opacity-50"
				disabled={!draft.trim() || sending}>Send</button
			>
		</form>
	{:else}
		<p class="border-t border-stone-700 px-3 py-2 text-xs text-stone-500">Take a seat to chat.</p>
	{/if}
</div>
