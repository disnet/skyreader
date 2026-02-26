<script lang="ts">
	import { page } from '$app/state';

	const links = [
		{ href: '/', label: 'Dashboard' },
		{ href: '/users', label: 'Users' },
		{ href: '/feeds', label: 'Feeds' }
	];
</script>

<nav>
	<a href="/" class="brand">Skyreader Admin</a>
	<div class="links">
		{#each links as link}
			<a href={link.href} class:active={page.url.pathname === link.href || (link.href !== '/' && page.url.pathname.startsWith(link.href))}>
				{link.label}
			</a>
		{/each}
	</div>
</nav>

<style>
	nav {
		display: flex;
		align-items: center;
		gap: 2rem;
		padding: 0.75rem 1.5rem;
		background: var(--color-bg-secondary);
		border-bottom: 1px solid var(--color-border);
	}

	.brand {
		font-weight: 700;
		font-size: 1.1rem;
		text-decoration: none;
		color: var(--color-text);
	}

	.links {
		display: flex;
		gap: 0.25rem;
	}

	.links a {
		padding: 0.4rem 0.75rem;
		border-radius: 6px;
		text-decoration: none;
		color: var(--color-text-secondary);
		font-weight: 500;
		font-size: 0.9rem;
	}

	.links a:hover {
		background: var(--color-border);
		color: var(--color-text);
	}

	.links a.active {
		background: var(--color-primary);
		color: white;
	}
</style>
