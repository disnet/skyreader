<script lang="ts">
	// No auth required - this is a public page
</script>

<svelte:head>
	<title>Terms of Service - Skyreader</title>
</svelte:head>

<div class="terms-page">
	<h1>Terms of Service</h1>
	<p class="last-updated">Last updated: January 2025</p>

	<section>
		<h2>1. What Skyreader Is</h2>
		<p>
			Skyreader is a decentralized RSS reader built on the AT Protocol. When you share articles,
			those shares are stored in your own Personal Data Server (PDS), making them portable and under
			your control. Subscriptions and read state are stored locally and on our servers.
		</p>
	</section>

	<section>
		<h2>2. Acceptable Use</h2>
		<p>You may use Skyreader to:</p>
		<ul>
			<li>Subscribe to and read RSS feeds</li>
			<li>Share articles with your followers</li>
			<li>Follow other users and see their shared content</li>
		</ul>
	</section>

	<section>
		<h2>3. Prohibited Content</h2>
		<p>You may not use Skyreader to share or distribute:</p>
		<ul>
			<li>
				<strong>Illegal content</strong> - Content that violates applicable law, including child sexual
				abuse material (CSAM), which will be reported to authorities
			</li>
			<li>
				<strong>Harassment</strong> - Targeted abuse, threats, or content intended to harm specific individuals
			</li>
			<li>
				<strong>Spam</strong> - Automated or bulk sharing intended to manipulate or deceive
			</li>
			<li>
				<strong>Malware</strong> - Links to malicious software or phishing attempts
			</li>
		</ul>
	</section>

	<section>
		<h2>4. Your Responsibilities</h2>
		<p>You are responsible for:</p>
		<ul>
			<li>The content you share through Skyreader</li>
			<li>Maintaining the security of your AT Protocol account</li>
			<li>Complying with applicable laws in your jurisdiction</li>
		</ul>
	</section>

	<section>
		<h2>5. Reporting Abuse</h2>
		<p>
			If you encounter content that violates these terms, please report it to
			<a href="mailto:abuse@skyreader.app">abuse@skyreader.app</a>. Include:
		</p>
		<ul>
			<li>The URL or identifier of the problematic content</li>
			<li>The DID or handle of the user who shared it</li>
			<li>A brief description of the violation</li>
		</ul>
		<p>We will review reports and take appropriate action, which may include:</p>
		<ul>
			<li>Removing cached content from our servers</li>
			<li>Blocking users from our service</li>
			<li>Reporting illegal content to appropriate authorities</li>
		</ul>
	</section>

	<section>
		<h2>6. Content and Data</h2>
		<p>
			Your shares are stored in your PDS, giving you ownership and portability of that data.
			Subscriptions and read state are stored on our servers and locally in your browser.
		</p>
		<p>
			We may remove cached content from our servers at any time, particularly if it violates these
			terms. Removing cached shares does not affect the original records in your PDS.
		</p>
	</section>

	<section>
		<h2>7. Service Availability</h2>
		<p>
			Skyreader is provided "as is" without warranty. We may modify, suspend, or discontinue the
			service at any time. Your shares remain accessible in your PDS and can be accessed through
			other AT Protocol applications.
		</p>
	</section>

	<section>
		<h2>8. Changes to Terms</h2>
		<p>
			We may update these terms from time to time. Continued use of Skyreader after changes
			constitutes acceptance of the new terms.
		</p>
	</section>

	<section class="contact">
		<h2>Contact</h2>
		<p>
			For abuse reports: <a href="mailto:abuse@skyreader.app">abuse@skyreader.app</a>
		</p>
		<p>
			For general feedback:
			<a href="https://github.com/disnet/skyreader/issues" target="_blank" rel="noopener"
				>GitHub Issues</a
			>
		</p>
	</section>
</div>

<style>
	.terms-page {
		max-width: 700px;
		margin: 0 auto;
		padding: 2rem 1rem;
	}

	h1 {
		font-size: 1.75rem;
		margin-bottom: 0.5rem;
		color: var(--color-text);
	}

	.last-updated {
		font-size: 0.875rem;
		color: var(--color-text-secondary);
		margin-bottom: 2rem;
	}

	section {
		margin-bottom: 2rem;
	}

	h2 {
		font-size: 1.125rem;
		margin-bottom: 0.75rem;
		color: var(--color-text);
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 0.5rem;
	}

	p {
		margin-bottom: 0.75rem;
		line-height: 1.6;
		color: var(--color-text);
	}

	ul {
		margin: 0.5rem 0 1rem;
		padding-left: 1.5rem;
	}

	li {
		margin-bottom: 0.5rem;
		line-height: 1.5;
		color: var(--color-text);
	}

	a {
		color: var(--color-primary);
		text-decoration: none;
	}

	a:hover {
		text-decoration: underline;
	}

	.contact {
		background: var(--color-bg-secondary);
		padding: 1rem 1.5rem;
		border-radius: 8px;
	}

	.contact h2 {
		border-bottom: none;
		padding-bottom: 0;
	}

	.contact p {
		margin-bottom: 0.5rem;
	}

	.contact p:last-child {
		margin-bottom: 0;
	}
</style>
