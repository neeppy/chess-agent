<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { pieceUrl } from '#lib/chess-ui.ts';
	import { forgetRoom, knownRooms, rememberSeat, savedName, saveName } from '#lib/seats.ts';
	import type { GameView } from '#lib/types.ts';

	let name = $state('');
	let color = $state<'white' | 'black' | 'any'>('white');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let joinCode = $state('');
	let origin = $state('');
	let recent = $state<{ code: string; game: GameView | null }[]>([]);

	onMount(async () => {
		origin = location.origin;
		name = savedName();
		const codes = knownRooms();
		recent = codes.map((code) => ({ code, game: null }));
		recent = await Promise.all(
			codes.map(async (code) => {
				const res = await fetch(`/api/rooms/${code}`).catch(() => null);
				if (res?.status === 404) forgetRoom(code);
				return { code, game: res?.ok ? ((await res.json()) as GameView) : null };
			})
		).then((list) => list.filter((r) => r.game));
	});

	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		const chosen = name.trim() || 'Guest';
		saveName(chosen);
		try {
			const res = await fetch('/api/rooms', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ join: { color, name: chosen } })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
			rememberSeat(data.room, { key: data.key, playerId: data.playerId });
			await goto(`/r/${data.room}`);
		} catch (err) {
			error = (err as Error).message;
			busy = false;
		}
	}

	function join(e: SubmitEvent) {
		e.preventDefault();
		const code = joinCode.trim().replace(/^.*\/r\//, '').replace(/[#?].*$/, '').toLowerCase();
		if (/^[a-z0-9]{6}$/.test(code)) goto(`/r/${code}`);
		else error = 'A room code is 6 letters or digits.';
	}

	function describe(g: GameView) {
		const w = g.seats.white?.name ?? 'empty';
		const b = g.seats.black?.name ?? 'empty';
		const state = g.status === 'finished' ? g.result : g.status === 'waiting' ? 'waiting for a player' : `move ${g.moveNumber}`;
		return { players: `${w} vs ${b}`, state };
	}

	const colors = [
		{ value: 'white', label: 'White' },
		{ value: 'any', label: 'Random' },
		{ value: 'black', label: 'Black' }
	] as const;
</script>

<svelte:head><title>Agentic Chess</title></svelte:head>

<div class="min-h-screen bg-stone-900 text-stone-100">
	<header class="mx-auto flex max-w-3xl items-center gap-3 px-4 py-6">
		<img src="/favicon.svg" alt="" class="size-9" />
		<div>
			<h1 class="text-xl font-semibold tracking-tight">Agentic Chess</h1>
			<p class="text-sm text-stone-400">Play chess with friends or AI agents. Anyone with a room link can join or watch.</p>
		</div>
	</header>

	<main class="mx-auto grid max-w-3xl gap-4 px-4 pb-10 md:grid-cols-2">
		<form class="space-y-4 rounded-xl bg-stone-800 p-5" onsubmit={create}>
			<h2 class="font-semibold">New room</h2>
			<label class="block">
				<span class="mb-1 block text-sm text-stone-400">Your name</span>
				<input
					bind:value={name}
					placeholder="Guest"
					maxlength="40"
					class="w-full rounded-md bg-stone-900 px-3 py-2 outline-none focus:ring-1 focus:ring-amber-500"
				/>
			</label>
			<div>
				<p class="mb-2 text-sm text-stone-400">You play</p>
				<div class="grid grid-cols-3 gap-2">
					{#each colors as o (o.value)}
						<button
							type="button"
							class="flex flex-col items-center gap-1 rounded-lg border-2 py-2 text-sm {color === o.value
								? 'border-amber-500 bg-stone-700'
								: 'border-transparent bg-stone-900 hover:bg-stone-700'}"
							onclick={() => (color = o.value)}
						>
							{#if o.value === 'any'}
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
			<button class="w-full rounded-md bg-amber-600 px-4 py-2 font-semibold hover:bg-amber-500 disabled:opacity-50" disabled={busy}
				>Create room</button
			>
		</form>

		<div class="flex flex-col gap-4">
			<form class="space-y-3 rounded-xl bg-stone-800 p-5" onsubmit={join}>
				<h2 class="font-semibold">Join a room</h2>
				<div class="flex gap-2">
					<input
						bind:value={joinCode}
						placeholder="Room code or link"
						class="min-w-0 flex-1 rounded-md bg-stone-900 px-3 py-2 font-mono outline-none focus:ring-1 focus:ring-amber-500"
					/>
					<button class="rounded-md bg-stone-700 px-4 py-2 hover:bg-stone-600">Go</button>
				</div>
			</form>

			<div class="space-y-2 rounded-xl bg-stone-800 p-5 text-sm">
				<h2 class="font-semibold">Play an AI agent</h2>
				<p class="text-stone-400">Connect your agent to this server's MCP endpoint, e.g. for Claude Code:</p>
				<code class="block rounded-md bg-stone-900 px-3 py-2 text-xs break-all text-stone-300"
					>claude mcp add --transport http --scope user chess {origin}/mcp</code
				>
				<p class="text-stone-400">
					Then tell it <span class="text-stone-200">“let's play chess”</span> (it creates a room and sends you a link), or create a room here
					and tell it <span class="text-stone-200">“join chess room &lt;code&gt;”</span>.
				</p>
			</div>
		</div>

		{#if error}
			<p class="rounded-md bg-red-900/60 px-3 py-2 text-sm text-red-200 md:col-span-2">{error}</p>
		{/if}

		{#if recent.length}
			<section class="rounded-xl bg-stone-800 md:col-span-2">
				<h2 class="border-b border-stone-700 px-5 py-3 font-semibold">Your rooms</h2>
				<ul class="divide-y divide-stone-700">
					{#each recent as r (r.code)}
						{@const d = r.game ? describe(r.game) : null}
						<li>
							<a href="/r/{r.code}" class="flex items-center gap-4 px-5 py-3 text-sm hover:bg-stone-700/50">
								<span class="font-mono text-stone-300">{r.code}</span>
								<span class="min-w-0 flex-1 truncate">{d?.players ?? '…'}</span>
								<span class="text-stone-400">{d?.state ?? ''}</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</main>
</div>
