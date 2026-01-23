<script lang="ts">
</script>

<div class="welcome">
	<div class="title-row">
		<h1>Welcome to Skyreader</h1>
		<span class="beta-badge">BETA</span>
	</div>
	<p>A decentralized RSS reader built on the AT Protocol.</p>

	<ul class="features">
		<li>Share articles with your followers</li>
		<li>Works offline with automatic sync</li>
	</ul>
	<div class="cta">
		<a href="/auth/login" class="btn btn-primary">Login with Bluesky</a>
	</div>
</div>

<style>
	.welcome {
		max-width: 600px;
		margin: 4rem auto;
		text-align: center;
	}

	.title-row {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		justify-content: center;
		margin-bottom: 1rem;
	}

	.welcome h1 {
		font-size: 2.5rem;
		margin-bottom: 0;
	}

	/* Web 2.0 style beta badge */
	.beta-badge {
		position: relative;
		padding: 4px 12px;
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: white;
		background: linear-gradient(180deg, #ff6b6b 0%, #ee2222 50%, #cc0000 100%);
		border-radius: 4px;
		transform: rotate(12deg);
		box-shadow:
			0 2px 4px rgba(0, 0, 0, 0.3),
			inset 0 1px 0 rgba(255, 255, 255, 0.4);
		border: 1px solid #aa0000;
	}

	/* Glossy highlight effect */
	.beta-badge::before {
		content: '';
		position: absolute;
		top: 1px;
		left: 2px;
		right: 2px;
		height: 45%;
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0.1) 100%);
		border-radius: 3px 3px 50% 50%;
		pointer-events: none;
	}

	.welcome p {
		font-size: 1.25rem;
		color: var(--color-text-secondary);
		margin-bottom: 2rem;
	}

	.features {
		list-style: none;
		margin-bottom: 2rem;
		text-align: left;
		display: inline-block;
		padding: 0;
	}

	.features li {
		padding: 0.5rem 0;
		padding-left: 1.5rem;
		position: relative;
	}

	.features li::before {
		content: '✓';
		position: absolute;
		left: 0;
		color: var(--color-success);
	}

	.cta {
		text-align: center;
	}

	.btn-primary {
		display: inline-block;
		padding: 0.75rem 1.5rem;
		background: var(--color-primary, #0066cc);
		color: #fff;
		border-radius: 4px;
		text-decoration: none;
		font-weight: 500;
	}

	.btn-primary:hover {
		background: var(--color-primary-dark, #0052a3);
	}
</style>
