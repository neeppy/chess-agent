<script lang="ts">
	import { onMount } from 'svelte';
	import Board from '#lib/components/Board.svelte';
	import Chat from '#lib/components/Chat.svelte';
	import GamesDialog from '#lib/components/GamesDialog.svelte';
	import MoveList from '#lib/components/MoveList.svelte';
	import PlayerBar from '#lib/components/PlayerBar.svelte';
	import PromotionPicker from '#lib/components/PromotionPicker.svelte';
	import SeatDialog from '#lib/components/SeatDialog.svelte';
	import { buildDests, captures, lichessUrl, other } from '#lib/chess-ui.ts';
	import { rememberRoom, rememberSeat, seatsIn, type StoredSeat } from '#lib/seats.ts';
	import type { Color, GameView, SeatView } from '#lib/types.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// svelte-ignore state_referenced_locally
	let game = $state<GameView>(data.initial);
	const code = $derived(game.room);
	let mySeats = $state<StoredSeat[]>([]);
	let streamUp = $state(true);
	let viewPly = $state<number | null>(null);
	let flipped = $state(false);
	let promotion = $state<{ from: string; to: string } | null>(null);
	let busy = $state(false);
	let toast = $state<string | null>(null);
	let muted = $state(false);
	let copied = $state<string | null>(null);
	let origin = $state('');
	let board = $state<Board>();
	let seatDialog = $state<SeatDialog>();
	let gamesDialog = $state<GamesDialog>();

	const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

	// --- who am I in this room
	const myIds = $derived(new Set(mySeats.map((s) => s.playerId)));
	const myColorsIn = (g: GameView): Color[] =>
		(['white', 'black'] as const).filter((c) => g.seats[c] && myIds.has(g.seats[c]!.playerId));
	const myColors = $derived(myColorsIn(game));
	const seated = $derived(myColors.length > 0);
	const keyFor = (c: Color) => mySeats.find((s) => s.playerId === game.seats[c]?.playerId)?.key;
	const myKey = $derived(myColors.length ? keyFor(myColors.includes(game.turn) ? game.turn : myColors[0]) : undefined);
	const opponentColor = $derived(myColors.length === 1 ? other(myColors[0]) : null);
	const opponent = $derived(opponentColor ? game.seats[opponentColor] : null);

	// --- board state
	const orientation: Color = $derived.by(() => {
		const base = myColors.length === 1 ? myColors[0] : 'white';
		return flipped ? other(base) : base;
	});
	const shownPly = $derived(viewPly ?? game.ply);
	const live = $derived(shownPly === game.ply);
	const shownMove = $derived(shownPly > 0 ? game.moves[shownPly - 1] : null);
	const shownFen = $derived(shownMove?.fen ?? game.startFen);
	const shownTurn: Color = $derived(shownPly % 2 === 0 ? 'white' : 'black');
	const shownCheck = $derived(live ? game.inCheck : /[+#]$/.test(shownMove?.san ?? ''));
	const active = $derived(game.status === 'active');
	const finished = $derived(game.status === 'finished');
	const myTurn = $derived(active && myColors.includes(game.turn));
	const canMove = $derived(myTurn && live && !busy && !promotion);
	const dests = $derived(buildDests(game.legalMoves));
	const caps = $derived(captures(shownFen));
	const canTakeBack = $derived(
		active &&
			seated &&
			(myColors.length === 2 || opponent?.kind === 'agent') &&
			game.ply >= (myTurn && myColors.length === 1 ? 2 : 1)
	);

	// --- presence: an agent over MCP keeps no connection open, so "seen in the last 10 minutes" counts
	let now = $state(Date.now());
	const online = (s: SeatView) =>
		s.connected || s.waiting || (s.lastSeen !== null && now - Date.parse(s.lastSeen) < 10 * 60_000);

	function badgeFor(c: Color) {
		const s = game.seats[c];
		if (!s || myColors.includes(c)) return null;
		if (!online(s)) return { text: 'offline', tone: 'off' as const };
		if (s.kind === 'agent') {
			if (active && game.turn === c)
				return s.turnNoticed ? { text: 'thinking…', tone: 'busy' as const } : { text: "hasn't seen the move", tone: 'off' as const };
			if (s.waiting) return { text: 'watching the board', tone: 'on' as const };
		}
		return { text: 'online', tone: 'on' as const };
	}

	const status = $derived.by(() => {
		if (finished) return game.termination ?? 'Game over';
		if (game.status === 'waiting') {
			const empty = game.seats.white ? 'Black' : 'White';
			return seated ? `Waiting for an opponent to take the ${empty} seat` : `The ${empty} seat is free`;
		}
		const mover = game.seats[game.turn]!;
		if (myTurn) return game.inCheck ? 'Your move — you are in check!' : 'Your move';
		if (seated && mover.kind === 'agent') return mover.turnNoticed ? `${mover.name} is thinking…` : `Waiting for ${mover.name}`;
		return seated ? `Waiting for ${mover.name}` : `${mover.name} (${cap(game.turn)}) to move`;
	});

	// An agent opponent with no waiter running doesn't see board moves on its own. Shown after a
	// short delay so it doesn't flash while the agent restarts its waiter.
	const watchHint = $derived.by(() => {
		if (!active || !opponent || opponent.kind !== 'agent' || !online(opponent)) return null;
		if (game.turn === opponentColor && !opponent.turnNoticed)
			return `${opponent.name} isn't watching the board right now. If it's your agent, tell it “your move” in your conversation.`;
		if (myTurn && !opponent.waiting)
			return `${opponent.name} isn't watching the board right now. After moving, tell it in your conversation, or just type your move there.`;
		return null;
	});
	let showWatchHint = $state(false);
	$effect(() => {
		showWatchHint = false;
		if (!watchHint) return;
		const t = setTimeout(() => (showWatchHint = true), 4000);
		return () => clearTimeout(t);
	});

	const title = $derived(myTurn ? '● Your move · Chess' : finished ? 'Game over · Chess' : `Room ${code} · Chess`);
	const roomLink = $derived(`${origin}/r/${code}`);

	// --- live updates
	function apply(next: GameView) {
		const prev = game;
		if (next.id !== prev.id) {
			viewPly = null;
			flipped = false;
			promotion = null;
		} else {
			if (next.version < prev.version) return; // stale
			const mine = myColorsIn(next);
			if (next.ply > prev.ply && next.lastMove && mine.length && !mine.includes(next.lastMove.color)) ping();
			if (viewPly !== null && (viewPly >= prev.ply || viewPly > next.ply)) viewPly = null;
		}
		game = next;
	}

	onMount(() => {
		origin = location.origin;
		mySeats = seatsIn(code);
		rememberRoom(code);
		try {
			muted = localStorage.getItem('chess:muted') === '1';
		} catch {
			/* storage unavailable */
		}
		claimSeatLink();
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	// The event stream tells the room which seat this browser holds, so others see it as present.
	const presenceId = $derived(mySeats.find((s) => myIds.has(s.playerId))?.playerId ?? null);
	$effect(() => {
		const es = new EventSource(`/api/rooms/${code}/events${presenceId ? `?as=${presenceId}` : ''}`);
		es.addEventListener('state', (e) => apply(JSON.parse((e as MessageEvent).data)));
		es.onopen = () => (streamUp = true);
		es.onerror = () => (streamUp = false);
		return () => es.close();
	});

	/** A seat link (/r/<code>#seat=<key>) hands this browser a seat someone created for it. */
	async function claimSeatLink() {
		if (!location.hash.startsWith('#seat=')) return;
		const key = decodeURIComponent(location.hash.slice('#seat='.length));
		history.replaceState(history.state, '', location.pathname);
		const res = await post('whoami', { seat: key });
		if (!res) return;
		rememberSeat(code, { key, playerId: res.playerId });
		mySeats = seatsIn(code);
	}

	function showToast(message: string) {
		toast = message;
		setTimeout(() => toast === message && (toast = null), 4000);
	}

	async function post(action: string, body: Record<string, unknown> = {}) {
		try {
			const res = await fetch(`/api/rooms/${code}/${action}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ seat: myKey, ...body })
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

	async function takeSeat(color: Color, name: string) {
		const res = await post('join', { color, name, seat: undefined });
		if (!res) return false;
		rememberSeat(code, { key: res.key, playerId: res.playerId });
		mySeats = seatsIn(code);
		return true;
	}

	async function play(uci: string) {
		busy = true;
		const ok = await post('move', { seat: keyFor(game.turn), move: uci });
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

	async function copy(what: string, text: string) {
		await navigator.clipboard.writeText(text);
		copied = what;
		setTimeout(() => copied === what && (copied = null), 1500);
	}

	function resign() {
		if (confirm('Resign this game?')) post('resign');
	}

	function newGame() {
		if (finished) post('rematch', { swap: true });
		else if (confirm('Abandon this game and start a new one?')) post('rematch', { swap: true, abandon: true });
	}

	const sendMessage = async (text: string) => !!(await post('message', { text }));

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
	const lead = (c: Color) => (c === 'white' ? caps.balance : -caps.balance);
	const takeable = (c: Color) => (!game.seats[c] ? () => seatDialog?.open(c) : null);
	// Spectators can take over an occupied seat (players don't get the button on their opponent's bar).
	const takeoverable = (c: Color) => (game.seats[c] && !seated ? () => seatDialog?.open(c, game.seats[c]!.name) : null);
</script>

{#snippet icon(name: string)}
	<svg viewBox="0 0 24 24" class="size-4" fill="currentColor" aria-hidden="true">
		{#if name === 'first'}<path d="M6 5h2v14H6zM19 5v14L9 12z" />
		{:else if name === 'prev'}<path d="M16 5v14L6 12z" />
		{:else if name === 'next'}<path d="M8 5v14l10-7z" />
		{:else if name === 'last'}<path d="M16 5h2v14h-2zM5 5v14l10-7z" />
		{:else if name === 'eye'}<path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
		{:else if name === 'sound'}<path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />
		{:else}<path d="M3 9v6h4l5 4V5L7 9H3zm13.6.4L15.2 10.8l1.8 1.8-1.8 1.8 1.4 1.4 1.8-1.8 1.8 1.8 1.4-1.4-1.8-1.8 1.8-1.8-1.4-1.4-1.8 1.8z" />
		{/if}
	</svg>
{/snippet}

<svelte:head><title>{title}</title></svelte:head>
<svelte:window onkeydown={onKey} />

<div class="min-h-screen bg-stone-900 text-stone-100">
	<header class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
		<a href="/" class="flex items-center gap-3">
			<img src="/favicon.svg" alt="" class="size-7" />
			<h1 class="hidden text-lg font-semibold tracking-tight whitespace-nowrap sm:block">Agentic Chess</h1>
		</a>
		<span class="rounded bg-stone-800 px-2 py-0.5 font-mono text-sm text-stone-300">{code}</span>
		{#if game.spectators > 0}
			<span class="flex items-center gap-1 text-xs text-stone-400" title="Watching">{@render icon('eye')}{game.spectators}</span>
		{/if}
		{#if !streamUp}
			<span class="rounded bg-red-900/60 px-2 py-0.5 text-xs text-red-200">reconnecting…</span>
		{/if}
		<nav class="ml-auto flex gap-1 text-sm whitespace-nowrap">
			<button class="rounded-md px-3 py-1.5 hover:bg-stone-800" onclick={() => gamesDialog?.open()}>Games</button>
			<a class="rounded-md bg-amber-600 px-3 py-1.5 font-semibold hover:bg-amber-500" href="/">New room</a>
		</nav>
	</header>

	<main class="mx-auto flex max-w-6xl flex-col gap-4 px-4 pb-6 lg:flex-row lg:items-start">
		<!-- Board column -->
		<section class="mx-auto flex w-full max-w-[min(100%,calc(100vh-11rem))] min-w-0 flex-col gap-2 lg:mx-0 lg:flex-1">
			<PlayerBar
				color={top}
				seat={game.seats[top]}
				captured={caps[top]}
				lead={lead(top)}
				active={active && game.turn === top}
				you={myColors.includes(top)}
				badge={badgeFor(top)}
				ontake={takeable(top)}
				ontakeover={takeoverable(top)}
			/>
			<!-- The board sits in a frame that carries the rank and file labels. -->
			<div
				class="grid grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] grid-rows-[1.5rem_auto_1.5rem] rounded-md bg-[#5a4130] shadow-lg ring-1 ring-black/40"
			>
				<div class="col-span-3"></div>
				<div class="flex flex-col" aria-hidden="true">
					{#each rankLabels as rank (rank)}
						<span class="flex flex-1 items-center justify-center text-sm font-semibold {rulerClass(rank === marked?.[1])}">{rank}</span>
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
						movableColor={canMove ? game.turn : undefined}
						dests={canMove ? dests : new Map()}
						onmove={onBoardMove}
					/>
					{#if promotion}
						<PromotionPicker color={game.turn} onpick={pickPromotion} oncancel={cancelPromotion} />
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
						<span class="flex flex-1 items-center justify-center text-sm font-semibold {rulerClass(file === marked?.[0])}">{file}</span>
					{/each}
				</div>
				<div></div>
			</div>
			<PlayerBar
				color={orientation}
				seat={game.seats[orientation]}
				captured={caps[orientation]}
				lead={lead(orientation)}
				active={active && game.turn === orientation}
				you={myColors.includes(orientation)}
				badge={badgeFor(orientation)}
				ontake={takeable(orientation)}
				ontakeover={takeoverable(orientation)}
			/>
		</section>

		<!-- Side panel -->
		<aside class="flex w-full flex-col gap-3 lg:h-[calc(100vh-5.5rem)] lg:w-96 lg:shrink-0">
			<div class="rounded-lg px-4 py-3 {finished ? 'bg-amber-900/50' : myTurn ? 'bg-emerald-900/50' : 'bg-stone-800'}">
				<p class="font-semibold">{status}</p>
				{#if finished}
					<p class="text-sm text-stone-300">Result: <span class="font-mono">{game.result}</span></p>
				{/if}
				{#if active && game.drawOffer}
					{#if seated && myColors.length === 1 && game.drawOffer !== myColors[0]}
						<div class="mt-2 flex items-center gap-2 text-sm">
							<span>{game.seats[game.drawOffer]?.name} offers a draw.</span>
							<button class="rounded bg-emerald-700 px-2.5 py-1 hover:bg-emerald-600" onclick={() => post('draw', { action: 'accept' })}>Accept</button>
							<button class="rounded bg-stone-700 px-2.5 py-1 hover:bg-stone-600" onclick={() => post('draw', { action: 'decline' })}>Decline</button>
						</div>
					{:else if seated}
						<p class="mt-1 text-sm text-stone-300">You offered a draw.</p>
					{:else}
						<p class="mt-1 text-sm text-stone-300">{game.seats[game.drawOffer]?.name} offers a draw.</p>
					{/if}
				{/if}
				{#if showWatchHint && watchHint}
					<p class="mt-2 text-sm text-stone-300">{watchHint}</p>
				{/if}
			</div>

			<!-- Invite -->
			<div class="rounded-lg bg-stone-800 px-4 py-3 text-sm {game.status === 'waiting' ? 'ring-1 ring-amber-600' : ''}">
				<div class="flex items-center gap-2">
					<span class="min-w-0 flex-1 truncate font-mono text-stone-300">{roomLink}</span>
					<button class={ctlBtn} onclick={() => copy('link', roomLink)}>{copied === 'link' ? 'Copied!' : 'Copy link'}</button>
				</div>
				<p class="mt-2 text-xs text-stone-400">
					Anyone with the link can take a free seat or watch. To invite an AI agent, tell it:
					<button class="font-mono text-stone-300 hover:underline" onclick={() => copy('agent', `Join chess room ${code}`)}
						>{copied === 'agent' ? 'copied!' : `“Join chess room ${code}”`}</button
					>
				</p>
			</div>

			<div class="flex min-h-48 flex-1 flex-col overflow-hidden rounded-lg bg-stone-800 lg:min-h-0">
				<div class="flex items-center border-b border-stone-700 px-2 py-1.5">
					<h2 class="px-1 text-sm font-semibold text-stone-300">Moves</h2>
					<div class="ml-auto flex gap-0.5">
						<button class={navBtn} title="First (Home)" onclick={() => go(0)}>{@render icon('first')}</button>
						<button class={navBtn} title="Previous (←)" onclick={() => go(shownPly - 1)}>{@render icon('prev')}</button>
						<button class={navBtn} title="Next (→)" onclick={() => go(shownPly + 1)}>{@render icon('next')}</button>
						<button class={navBtn} title="Latest (End)" onclick={() => go(game.ply)}>{@render icon('last')}</button>
					</div>
				</div>
				<MoveList moves={game.moves} shown={shownPly} onselect={go} />
				<div class="flex flex-wrap gap-1 border-t border-stone-700 p-2 text-sm">
					<button class={ctlBtn} onclick={() => (flipped = !flipped)} title="Flip board (f)">Flip</button>
					{#if seated}
						{#if finished}
							<button class={ctlBtn} onclick={newGame}>Rematch</button>
						{:else if game.status === 'waiting' || game.ply === 0}
							<button class={ctlBtn} onclick={() => post('leave')}>Leave seat</button>
						{:else}
							<button class={ctlBtn} disabled={!canTakeBack || busy} onclick={() => post('takeback')}>Takeback</button>
							<button class={ctlBtn} disabled={!active || game.drawOffer !== null || myColors.length === 2} onclick={() => post('draw', { action: 'offer' })}
								>Offer draw</button
							>
							<button class={ctlBtn} disabled={!active} onclick={resign}>Resign</button>
							<button class={ctlBtn} onclick={newGame} title="Abandon this game and start a new one">New game</button>
						{/if}
					{/if}
					<button class="{ctlBtn} ml-auto" onclick={toggleMute} title="Sound when your opponent moves">{@render icon(muted ? 'mute' : 'sound')}</button>
				</div>
			</div>

			<div class="flex h-64 flex-col overflow-hidden rounded-lg bg-stone-800 lg:h-auto lg:min-h-0 lg:flex-1">
				<h2 class="border-b border-stone-700 px-3 py-2 text-sm font-semibold text-stone-300">Chat</h2>
				<Chat
					messages={game.messages}
					myPlayerIds={[...myIds]}
					seenUpTo={opponent?.kind === 'agent' ? opponent.readMessageId : 0}
					canSend={seated}
					onsend={sendMessage}
				/>
			</div>

			<div class="flex flex-wrap items-center gap-1 rounded-lg bg-stone-800 p-2 text-sm">
				<span class="px-1 font-semibold text-stone-300">PGN</span>
				<button class={ctlBtn} onclick={() => copy('pgn', game.pgn)}>{copied === 'pgn' ? 'Copied!' : 'Copy'}</button>
				<a class={ctlBtn} href="/api/rooms/{code}/pgn?download">Download</a>
				<a class={ctlBtn} href={lichessUrl(game.pgn)} target="_blank" rel="noopener">Analyze on lichess ↗</a>
			</div>
		</aside>
	</main>

	{#if toast}
		<div class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-800 px-4 py-2 text-sm shadow-xl">{toast}</div>
	{/if}
</div>

<SeatDialog bind:this={seatDialog} ontake={takeSeat} />
<GamesDialog bind:this={gamesDialog} room={code} />
