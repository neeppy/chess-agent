<script lang="ts">
	import { onMount } from 'svelte';
	import Board from '#lib/components/Board.svelte';
	import Chat from '#lib/components/Chat.svelte';
	import GamesDialog from '#lib/components/GamesDialog.svelte';
	import MoveList from '#lib/components/MoveList.svelte';
	import NewGameDialog from '#lib/components/NewGameDialog.svelte';
	import PlayerBar from '#lib/components/PlayerBar.svelte';
	import PromotionPicker from '#lib/components/PromotionPicker.svelte';
	import { buildDests, captures, lichessUrl, other } from '#lib/chess-ui.ts';
	import type { Color, GameView } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let game = $state<GameView>(data.initial);
	let streamUp = $state(true);
	let viewPly = $state<number | null>(null);
	let flipped = $state(false);
	let promotion = $state<{ from: string; to: string } | null>(null);
	let busy = $state(false);
	let toast = $state<string | null>(null);
	let muted = $state(false);
	let copied = $state(false);
	let board = $state<Board>();
	let newGameDialog = $state<NewGameDialog>();
	let gamesDialog = $state<GamesDialog>();

	const orientation: Color = $derived(flipped ? other(game.humanColor) : game.humanColor);
	const shownPly = $derived(viewPly ?? game.ply);
	const live = $derived(shownPly === game.ply);
	const shownMove = $derived(shownPly > 0 ? game.moves[shownPly - 1] : null);
	const shownFen = $derived(shownMove?.fen ?? game.startFen);
	const shownTurn: Color = $derived(shownPly % 2 === 0 ? 'white' : 'black');
	const shownCheck = $derived(live ? game.inCheck : /[+#]$/.test(shownMove?.san ?? ''));
	const active = $derived(game.status === 'active');
	const myTurn = $derived(active && game.turnSide === 'human');
	const canMove = $derived(myTurn && live && !busy && !promotion);
	const dests = $derived(buildDests(game.legalMoves));
	const caps = $derived(captures(shownFen));
	const canTakeBack = $derived(active && game.moves.length >= (game.turnSide === 'agent' ? 1 : 2));

	// MCP over HTTP keeps no connection open, so an agent seen in the last 10 minutes counts too.
	let now = $state(Date.now());
	let origin = $state('');
	onMount(() => {
		origin = location.origin;
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
	const agentOnline = $derived(
		game.agent.connected ||
			game.agent.waiting ||
			(game.agent.lastSeen !== null && now - Date.parse(game.agent.lastSeen) < 10 * 60_000)
	);

	const agentBadge = $derived.by(() => {
		const a = game.agent;
		if (!agentOnline) return { text: 'not connected', tone: 'off' as const };
		if (active && game.turnSide === 'agent')
			return a.turnNoticed
				? { text: 'thinking…', tone: 'busy' as const }
				: { text: "hasn't seen your move", tone: 'off' as const };
		if (active && a.waiting) return { text: 'watching the board', tone: 'on' as const };
		return { text: 'connected', tone: 'on' as const };
	});

	const status = $derived.by(() => {
		if (!active) return game.termination ?? 'Game over';
		if (game.turnSide === 'human') return game.inCheck ? 'Your move — you are in check!' : 'Your move';
		if (!agentOnline) return `Waiting for ${game.agentName} to connect…`;
		return game.agent.turnNoticed ? `${game.agentName} is thinking…` : `Waiting for ${game.agentName}`;
	});

	// When the agent isn't watching the board (no waiter running), board moves don't reach it on
	// their own. Shown after a short delay so it doesn't flash while the agent restarts its waiter.
	const watchHint = $derived.by(() => {
		if (!active || !agentOnline) return null;
		if (game.turnSide === 'agent' && !game.agent.turnNoticed)
			return `${game.agentName} isn't watching the board right now. Tell it “your move” in your Claude conversation.`;
		if (game.turnSide === 'human' && !game.agent.waiting)
			return `${game.agentName} isn't watching the board right now. After moving here, tell it in your Claude conversation, or just type your move there.`;
		return null;
	});
	let showWatchHint = $state(false);
	$effect(() => {
		showWatchHint = false;
		if (!watchHint) return;
		const t = setTimeout(() => (showWatchHint = true), 4000);
		return () => clearTimeout(t);
	});

	const title = $derived(
		!active ? 'Game over · Chess' : myTurn ? '● Your move · Chess' : `${game.agentName} to move · Chess`
	);

	function apply(next: GameView) {
		const prev = game;
		if (next.id !== prev.id) {
			viewPly = null;
			flipped = false;
			promotion = null;
		} else {
			if (next.version < prev.version) return; // stale
			if (next.ply > prev.ply && next.lastMove?.color === next.agentColor) ping();
			if (viewPly !== null && (viewPly >= prev.ply || viewPly > next.ply)) viewPly = null;
		}
		game = next;
	}

	onMount(() => {
		try {
			muted = localStorage.getItem('chess:muted') === '1';
		} catch {
			/* storage unavailable */
		}
		const es = new EventSource('/api/events');
		es.addEventListener('state', (e) => apply(JSON.parse((e as MessageEvent).data)));
		es.onopen = () => (streamUp = true);
		es.onerror = () => (streamUp = false);
		return () => es.close();
	});

	function showToast(message: string) {
		toast = message;
		setTimeout(() => toast === message && (toast = null), 4000);
	}

	async function post(action: string, body: Record<string, unknown> = {}) {
		try {
			const res = await fetch(`/api/game/${action}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = await res.json();
			if (!res.ok) {
				showToast(data.error ?? `Request failed (${res.status})`);
				return null;
			}
			if (data.game) apply(data.game);
			return data;
		} catch {
			showToast('Could not reach the server.');
			return null;
		}
	}

	async function play(uci: string) {
		busy = true;
		const ok = await post('move', { as: 'human', move: uci });
		busy = false;
		if (!ok) board?.reset();
	}

	function onBoardMove(from: string, to: string) {
		if (game.legalMoves.some((m) => m.from === from && m.to === to && m.promotion)) {
			promotion = { from, to };
			return;
		}
		play(from + to);
	}

	function pickPromotion(piece: string) {
		const p = promotion!;
		promotion = null;
		play(p.from + p.to + piece);
	}

	function cancelPromotion() {
		promotion = null;
		board?.reset();
	}

	function go(ply: number) {
		viewPly = Math.max(0, Math.min(game.ply, ply));
		if (viewPly === game.ply) viewPly = null;
	}

	function onKey(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		if (target.closest('input, textarea, dialog')) return;
		if (e.key === 'ArrowLeft') go(shownPly - 1);
		else if (e.key === 'ArrowRight') go(shownPly + 1);
		else if (e.key === 'Home') go(0);
		else if (e.key === 'End') go(game.ply);
		else if (e.key === 'f') flipped = !flipped;
		else return;
		e.preventDefault();
	}

	let audio: AudioContext | undefined;
	function ping() {
		if (muted) return;
		try {
			audio ??= new AudioContext();
			const t = audio.currentTime;
			const osc = audio.createOscillator();
			const gain = audio.createGain();
			osc.type = 'triangle';
			osc.frequency.setValueAtTime(620, t);
			gain.gain.setValueAtTime(0.0001, t);
			gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
			gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
			osc.connect(gain).connect(audio.destination);
			osc.start(t);
			osc.stop(t + 0.2);
		} catch {
			/* audio unavailable */
		}
	}

	function toggleMute() {
		muted = !muted;
		try {
			localStorage.setItem('chess:muted', muted ? '1' : '0');
		} catch {
			/* storage unavailable */
		}
	}

	function resign() {
		if (confirm('Resign this game?')) post('resign', { as: 'human' });
	}

	async function copyPgn() {
		await navigator.clipboard.writeText(game.pgn);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	async function startGame(opts: { humanColor: string; humanName: string }) {
		return !!(await post('new', { ...opts, abandon: true }));
	}

	async function sendMessage(text: string) {
		return !!(await post('message', { as: 'human', text }));
	}

	const navBtn = 'rounded px-2 py-1 text-stone-300 hover:bg-stone-700';
	const ctlBtn =
		'rounded-md bg-stone-700 px-2.5 py-1 text-stone-100 hover:bg-stone-600 disabled:cursor-not-allowed disabled:opacity-40';

	// Rulers around the board, in the order the viewer sees them. The last move's destination
	// square is highlighted on both, so "Nf6" reads straight off the edges.
	const rankLabels = $derived(orientation === 'white' ? [...'87654321'] : [...'12345678']);
	const fileLabels = $derived(orientation === 'white' ? [...'abcdefgh'] : [...'hgfedcba']);
	const marked = $derived(shownMove?.to ?? null);
	const rulerClass = (on: boolean) => (on ? 'text-amber-300' : 'text-[#f0d9b5]/80');

	const top: Color = $derived(other(orientation));
	const playerName = (c: Color) => (c === 'white' ? game.white : game.black);
	const isAgent = (c: Color) => c === game.agentColor;
	const lead = (c: Color) => (c === 'white' ? caps.balance : -caps.balance);
</script>

{#snippet icon(name: string)}
	<svg viewBox="0 0 24 24" class="size-4" fill="currentColor" aria-hidden="true">
		{#if name === "first"}<path d="M6 5h2v14H6zM19 5v14L9 12z" />
		{:else if name === "prev"}<path d="M16 5v14L6 12z" />
		{:else if name === "next"}<path d="M8 5v14l10-7z" />
		{:else if name === "last"}<path d="M16 5h2v14h-2zM5 5v14l10-7z" />
		{:else if name === "sound"}<path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />
		{:else}<path d="M3 9v6h4l5 4V5L7 9H3zm13.6.4L15.2 10.8l1.8 1.8-1.8 1.8 1.4 1.4 1.8-1.8 1.8 1.8 1.4-1.4-1.8-1.8 1.8-1.8-1.4-1.4-1.8 1.8z" />
		{/if}
	</svg>
{/snippet}

<svelte:head><title>{title}</title></svelte:head>
<svelte:window onkeydown={onKey} />

<div class="min-h-screen bg-stone-900 text-stone-100">
	<header class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
		<img src="/favicon.svg" alt="" class="size-7" />
		<h1 class="text-lg font-semibold tracking-tight whitespace-nowrap">Agentic Chess</h1>
		{#if !streamUp}
			<span class="rounded bg-red-900/60 px-2 py-0.5 text-xs text-red-200">reconnecting…</span>
		{/if}
		<nav class="ml-auto flex gap-1 text-sm whitespace-nowrap">
			<button class="rounded-md px-3 py-1.5 hover:bg-stone-800" onclick={() => gamesDialog?.open()}>Games</button>
			<button
				class="rounded-md bg-amber-600 px-3 py-1.5 font-semibold hover:bg-amber-500"
				onclick={() => newGameDialog?.open()}>New game</button
			>
		</nav>
	</header>

	<main class="mx-auto flex max-w-6xl flex-col gap-4 px-4 pb-6 lg:flex-row lg:items-start">
		<!-- Board column -->
		<section class="mx-auto flex w-full max-w-[min(100%,calc(100vh-11rem))] min-w-0 flex-col gap-2 lg:mx-0 lg:flex-1">
			<PlayerBar
				name={playerName(top)}
				color={top}
				captured={caps[top]}
				lead={lead(top)}
				active={active && game.turn === top}
				badge={isAgent(top) ? agentBadge : null}
				label={isAgent(top) ? '' : '(you)'}
			/>
			<!-- The board sits in a frame that carries the rank and file labels. -->
			<div
				class="grid grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] grid-rows-[1.5rem_auto_1.5rem] rounded-md bg-[#5a4130] shadow-lg ring-1 ring-black/40"
			>
				<div class="col-span-3"></div>
				<div class="flex flex-col" aria-hidden="true">
					{#each rankLabels as rank (rank)}
						<span class="flex flex-1 items-center justify-center text-sm font-semibold {rulerClass(rank === marked?.[1])}"
							>{rank}</span
						>
					{/each}
				</div>
				<div class="relative aspect-square">
					<Board
						bind:this={board}
						fen={shownFen}
						{orientation}
						turnColor={shownTurn}
						lastMove={shownMove ? [shownMove.from, shownMove.to] : null}
						check={shownCheck}
						movableColor={canMove ? game.humanColor : undefined}
						dests={canMove ? dests : new Map()}
						onmove={onBoardMove}
					/>
					{#if promotion}
						<PromotionPicker color={game.humanColor} onpick={pickPromotion} oncancel={cancelPromotion} />
					{/if}
					{#if !live}
						<button
							class="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-amber-600 px-4 py-1.5 text-sm font-semibold shadow-lg hover:bg-amber-500"
							onclick={() => go(game.ply)}>Viewing move {Math.ceil(shownPly / 2)} — back to live</button
						>
					{/if}
				</div>
				<div></div>
				<div></div>
				<div class="flex" aria-hidden="true">
					{#each fileLabels as file (file)}
						<span class="flex flex-1 items-center justify-center text-sm font-semibold {rulerClass(file === marked?.[0])}"
							>{file}</span
						>
					{/each}
				</div>
				<div></div>
			</div>
			<PlayerBar
				name={playerName(orientation)}
				color={orientation}
				captured={caps[orientation]}
				lead={lead(orientation)}
				active={active && game.turn === orientation}
				badge={isAgent(orientation) ? agentBadge : null}
				label={isAgent(orientation) ? '' : '(you)'}
			/>
		</section>

		<!-- Side panel -->
		<aside class="flex w-full flex-col gap-3 lg:h-[calc(100vh-5.5rem)] lg:w-96 lg:shrink-0">
			<div
				class="rounded-lg px-4 py-3 {!active
					? 'bg-amber-900/50'
					: myTurn
						? 'bg-emerald-900/50'
						: 'bg-stone-800'}"
			>
				<p class="font-semibold">{status}</p>
				{#if !active}
					<p class="text-sm text-stone-300">Result: <span class="font-mono">{game.result}</span></p>
				{/if}
				{#if active && game.drawOffer === 'agent'}
					<div class="mt-2 flex items-center gap-2 text-sm">
						<span>{game.agentName} offers a draw.</span>
						<button class="rounded bg-emerald-700 px-2.5 py-1 hover:bg-emerald-600" onclick={() => post('draw', { as: 'human', action: 'accept' })}>Accept</button>
						<button class="rounded bg-stone-700 px-2.5 py-1 hover:bg-stone-600" onclick={() => post('draw', { as: 'human', action: 'decline' })}>Decline</button>
					</div>
				{:else if active && game.drawOffer === 'human'}
					<p class="mt-1 text-sm text-stone-300">You offered a draw.</p>
				{/if}
				{#if active && game.turnSide === 'agent' && !game.agent.connected && !game.agent.waiting}
					<p class="mt-2 text-sm text-stone-300">
						Connect an agent to <code class="rounded bg-stone-900 px-1">{origin}/mcp</code> (see the README) and tell it “let's play chess”.
					</p>
				{:else if showWatchHint && watchHint}
					<p class="mt-2 text-sm text-stone-300">{watchHint}</p>
				{/if}
			</div>

			<div class="flex min-h-48 flex-1 flex-col overflow-hidden rounded-lg bg-stone-800 lg:min-h-0">
				<div class="flex items-center border-b border-stone-700 px-2 py-1.5">
					<h2 class="px-1 text-sm font-semibold text-stone-300">Moves</h2>
					<div class="ml-auto flex gap-0.5">
						<button class={navBtn} title="First (Home)" onclick={() => go(0)}>{@render icon("first")}</button>
						<button class={navBtn} title="Previous (←)" onclick={() => go(shownPly - 1)}>{@render icon("prev")}</button>
						<button class={navBtn} title="Next (→)" onclick={() => go(shownPly + 1)}>{@render icon("next")}</button>
						<button class={navBtn} title="Latest (End)" onclick={() => go(game.ply)}>{@render icon("last")}</button>
					</div>
				</div>
				<MoveList moves={game.moves} shown={shownPly} onselect={go} />
				<div class="flex flex-wrap gap-1 border-t border-stone-700 p-2 text-sm">
					<button class={ctlBtn} onclick={() => (flipped = !flipped)} title="Flip board (f)">Flip</button>
					<button class={ctlBtn} disabled={!canTakeBack || busy} onclick={() => post('takeback')}>Takeback</button>
					<button
						class={ctlBtn}
						disabled={!active || game.drawOffer !== null}
						onclick={() => post('draw', { as: 'human', action: 'offer' })}>Offer draw</button
					>
					<button class={ctlBtn} disabled={!active} onclick={resign}>Resign</button>
					<button class="{ctlBtn} ml-auto" onclick={toggleMute} title="Sound when {game.agentName} moves">{@render icon(muted ? "mute" : "sound")}</button>
				</div>
			</div>

			<div class="flex h-64 flex-col overflow-hidden rounded-lg bg-stone-800 lg:h-auto lg:min-h-0 lg:flex-1">
				<h2 class="border-b border-stone-700 px-3 py-2 text-sm font-semibold text-stone-300">Chat</h2>
				<Chat
					messages={game.messages}
					agentName={game.agentName}
					agentReadMessageId={game.agentReadMessageId}
					onsend={sendMessage}
				/>
			</div>

			<div class="flex flex-wrap items-center gap-1 rounded-lg bg-stone-800 p-2 text-sm">
				<span class="px-1 font-semibold text-stone-300">PGN</span>
				<button class={ctlBtn} onclick={copyPgn}>{copied ? 'Copied!' : 'Copy'}</button>
				<a class={ctlBtn} href="/api/game/pgn?download">Download</a>
				<a class={ctlBtn} href={lichessUrl(game.pgn)} target="_blank" rel="noopener">Analyze on lichess ↗</a>
			</div>
		</aside>
	</main>

	{#if toast}
		<div class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-800 px-4 py-2 text-sm shadow-xl">
			{toast}
		</div>
	{/if}
</div>

<NewGameDialog
	bind:this={newGameDialog}
	defaultName={game.humanName}
	inProgress={active && game.ply > 0}
	onstart={startGame}
/>
<GamesDialog bind:this={gamesDialog} />

