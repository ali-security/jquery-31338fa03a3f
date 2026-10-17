#!/usr/bin/env node
/*
 * Headless QUnit runner for the jQuery unit-test suite (test/index.html).
 *
 * Requires Node >= 18 and puppeteer-core (installed outside the project, e.g.
 * `npm install --prefix /tmp/qunit-runner puppeteer-core`; point NODE_PATH or
 * PUPPETEER_CORE_PATH at it). Drives a system Chrome/Chromium, hooks the
 * QUnit 1.x logging callbacks before any test runs, prints every failing
 * assertion, per-module pass/fail counts and a final summary line:
 *
 *   QUnit: N tests, X assertions passed, Y failed, total Z
 *
 * Exits 0 only if the suite completed with zero failed assertions.
 *
 * Usage:
 *   node test/run-qunit-headless.js [--serve] [url-or-path ...]
 *
 *   Each argument is a test page to run (sequentially, in one browser). With
 *   --serve the runner starts its own HTTP server on 127.0.0.1 rooted at the
 *   repository root (static files directly, *.php through php-cgi, one CGI
 *   process per request) and arguments may be paths such as
 *   "test/index.html?dev". Without --serve, arguments must be full URLs of an
 *   already running PHP-capable server. Default page: test/index.html.
 *
 *   Why --serve: the suite needs real concurrency from the server (e.g.
 *   test/data/core/dont_return.php sleeps 30s while other requests must keep
 *   flowing). `php -S` runs each worker single-threaded and can park an
 *   already-accepted connection behind a sleeping script, which shows up as
 *   random "Test timed out" failures in iframe/ready tests.
 *
 * This file uses modern Node syntax and is excluded from the 2014 jshint run
 * via .jshintignore.
 *
 * Environment:
 *   CHROME_PATH          Chrome executable (default: first of google-chrome,
 *                        google-chrome-stable, chromium, chromium-browser on PATH)
 *   PUPPETEER_CORE_PATH  Directory to require puppeteer-core from
 *   PHP_CGI              php-cgi executable for --serve (default: php-cgi on PATH)
 *   QUNIT_PORT           Port for --serve (default: 0 = pick a free port)
 *   QUNIT_TIMEOUT_MS     Overall timeout per page (default 600000 = 10 minutes)
 */
"use strict";

const childProcess = require( "child_process" );
const fs = require( "fs" );
const http = require( "http" );
const path = require( "path" );

function loadPuppeteer() {
	const candidates = [];
	if ( process.env.PUPPETEER_CORE_PATH ) {
		candidates.push( path.join( process.env.PUPPETEER_CORE_PATH, "node_modules", "puppeteer-core" ) );
		candidates.push( process.env.PUPPETEER_CORE_PATH );
	}
	candidates.push( "puppeteer-core" );
	for ( const candidate of candidates ) {
		try {
			return require( candidate );
		} catch ( e ) {
			if ( e.code !== "MODULE_NOT_FOUND" ) {
				throw e;
			}
		}
	}
	throw new Error( "puppeteer-core not found; set PUPPETEER_CORE_PATH or NODE_PATH" );
}

function findChrome() {
	if ( process.env.CHROME_PATH ) {
		return process.env.CHROME_PATH;
	}
	const names = [ "google-chrome", "google-chrome-stable", "chromium", "chromium-browser" ];
	const dirs = ( process.env.PATH || "" ).split( path.delimiter );
	for ( const name of names ) {
		for ( const dir of dirs ) {
			const full = path.join( dir, name );
			try {
				fs.accessSync( full, fs.constants.X_OK );
				return full;
			} catch ( e ) {
				// keep looking
			}
		}
	}
	throw new Error( "Chrome not found; set CHROME_PATH" );
}

// Runs in the page before any of its scripts. QUnit 1.x publishes itself with
// `window.QUnit = QUnit`, so trap that assignment and register the logging
// callbacks immediately (the suite uses autostart=false, so nothing has run yet).
function installHooks() {
	if ( window.top !== window ) {
		// iframes use parent.QUnit; only hook the top-level test page
		return;
	}
	let qunit;
	function hook( Q ) {
		if ( !Q || Q.__headlessHooked || typeof Q.log !== "function" ) {
			return;
		}
		Q.__headlessHooked = true;
		const report = function( type, data ) {
			try {
				window.__qunitReport( JSON.stringify( { type: type, data: data } ) );
			} catch ( e ) {
				// ignore reporting errors
			}
		};
		const safe = function( value ) {
			try {
				return Q.jsDump ? Q.jsDump.parse( value ) : String( value );
			} catch ( e ) {
				return String( value );
			}
		};
		Q.testStart( function( d ) {
			report( "testStart", { module: d.module, name: d.name } );
		});
		Q.log( function( d ) {
			if ( d.result ) {
				return;
			}
			report( "fail", {
				module: d.module,
				name: d.name,
				message: d.message || "",
				actual: "actual" in d ? safe( d.actual ) : undefined,
				expected: "expected" in d ? safe( d.expected ) : undefined,
				source: d.source || ""
			});
		});
		Q.testDone( function( d ) {
			report( "testDone", { module: d.module, name: d.name, failed: d.failed,
				passed: d.passed, total: d.total } );
		});
		Q.moduleDone( function( d ) {
			report( "moduleDone", { name: d.name, failed: d.failed, passed: d.passed,
				total: d.total } );
		});
		Q.done( function( d ) {
			report( "done", { failed: d.failed, passed: d.passed, total: d.total,
				runtime: d.runtime } );
		});
	}
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunit;
		},
		set: function( value ) {
			qunit = value;
			hook( value );
		}
	});
}

const MIME_TYPES = {
	".css": "text/css",
	".gif": "image/gif",
	".htm": "text/html; charset=UTF-8",
	".html": "text/html; charset=UTF-8",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "application/javascript",
	".json": "application/json",
	".map": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=UTF-8",
	".xhtml": "application/xhtml+xml",
	".xml": "application/xml"
};

function runPhpCgi( phpCgi, root, file, req, res, urlPath, query, pathInfo ) {
	const env = {
		PATH: process.env.PATH || "/usr/bin:/bin",
		GATEWAY_INTERFACE: "CGI/1.1",
		SERVER_SOFTWARE: "qunit-headless",
		SERVER_PROTOCOL: "HTTP/" + req.httpVersion,
		SERVER_NAME: "127.0.0.1",
		SERVER_PORT: String( req.socket.localPort ),
		SERVER_ADDR: req.socket.localAddress,
		REMOTE_ADDR: req.socket.remoteAddress,
		REMOTE_PORT: String( req.socket.remotePort ),
		REQUEST_METHOD: req.method,
		REQUEST_URI: req.url,
		QUERY_STRING: query,
		DOCUMENT_ROOT: root,
		SCRIPT_FILENAME: file,
		SCRIPT_NAME: urlPath,
		PHP_SELF: urlPath + ( pathInfo || "" ),
		REDIRECT_STATUS: "200"
	};
	if ( pathInfo ) {
		env.PATH_INFO = pathInfo;
		env.PATH_TRANSLATED = path.join( root, pathInfo );
	}
	if ( req.headers[ "content-type" ] ) {
		env.CONTENT_TYPE = req.headers[ "content-type" ];
	}
	if ( req.headers[ "content-length" ] ) {
		env.CONTENT_LENGTH = req.headers[ "content-length" ];
	}
	for ( const name of Object.keys( req.headers ) ) {
		const key = "HTTP_" + name.toUpperCase().replace( /-/g, "_" );
		const value = req.headers[ name ];
		env[ key ] = Array.isArray( value ) ? value.join( ", " ) : value;
	}

	const child = childProcess.spawn( phpCgi, [ "-d", "display_errors=stderr" ],
		{ cwd: path.dirname( file ), env: env } );
	const chunks = [];
	child.stdout.on( "data", function( chunk ) {
		chunks.push( chunk );
	} );
	child.stderr.on( "data", function( chunk ) {
		process.stderr.write( "[php-cgi " + urlPath + "] " + chunk );
	} );
	child.on( "error", function( err ) {
		if ( !res.headersSent ) {
			res.writeHead( 500, { "Content-Type": "text/plain" } );
		}
		res.end( "php-cgi failed: " + err.message );
	} );
	child.on( "close", function() {
		if ( res.headersSent ) {
			return;
		}
		const out = Buffer.concat( chunks );
		let sep = out.indexOf( "\r\n\r\n" );
		let sepLength = 4;
		if ( sep === -1 ) {
			sep = out.indexOf( "\n\n" );
			sepLength = 2;
		}
		if ( sep === -1 ) {
			res.writeHead( 502, { "Content-Type": "text/plain" } );
			res.end( "Malformed php-cgi output for " + urlPath );
			return;
		}
		const headers = {};
		let status = 200;
		let reason;
		for ( const line of out.slice( 0, sep ).toString( "latin1" ).split( /\r?\n/ ) ) {
			const colon = line.indexOf( ":" );
			if ( colon <= 0 ) {
				continue;
			}
			const name = line.slice( 0, colon ).trim();
			const value = line.slice( colon + 1 ).trim();
			if ( name.toLowerCase() === "status" ) {
				const m = /^(\d{3})\s*(.*)$/.exec( value );
				if ( m ) {
					status = parseInt( m[ 1 ], 10 );
					reason = m[ 2 ] || undefined;
				}
				continue;
			}
			if ( name.toLowerCase() === "location" && status === 200 ) {
				status = 302;
			}
			if ( headers[ name ] === undefined ) {
				headers[ name ] = value;
			} else {
				headers[ name ] = [].concat( headers[ name ], value );
			}
		}
		const body = out.slice( sep + sepLength );
		res.writeHead( status, reason, headers );
		res.end( req.method === "HEAD" || status === 204 || status === 304 ? undefined : body );
	} );
	req.pipe( child.stdin );
	child.stdin.on( "error", function() {} );
}

// Map a filesystem path to an existing file, supporting PATH_INFO the way
// Apache/`php -S` do: "data/jsonp.php/??" runs data/jsonp.php with PATH_INFO "/??".
function resolveTarget( root, file ) {
	let candidate = file;
	let pathInfo = "";
	if ( candidate.length > 1 && candidate.endsWith( path.sep ) ) {
		candidate = candidate.slice( 0, -1 );
		pathInfo = path.sep;
	}
	while ( candidate.length > root.length ) {
		let stat = null;
		try {
			stat = fs.statSync( candidate );
		} catch ( e ) {
			// not there; try the parent
		}
		if ( stat && stat.isFile() ) {
			return { file: candidate, pathInfo: pathInfo, size: stat.size };
		}
		if ( stat ) {
			return null;
		}
		pathInfo = candidate.slice( path.dirname( candidate ).length ) + pathInfo;
		candidate = path.dirname( candidate );
	}
	return null;
}

// Concurrent server: static files from disk, *.php through one php-cgi process
// per request (the setup the suite was written for is Apache + mod_php).
function startServer( root, port ) {
	const phpCgi = process.env.PHP_CGI || "php-cgi";
	const server = http.createServer( function( req, res ) {
		const qIndex = req.url.indexOf( "?" );
		const query = qIndex === -1 ? "" : req.url.slice( qIndex + 1 );
		let urlPath;
		try {
			urlPath = decodeURIComponent( qIndex === -1 ? req.url : req.url.slice( 0, qIndex ) );
		} catch ( e ) {
			res.writeHead( 400 );
			res.end();
			return;
		}
		const file = path.join( root, path.normalize( urlPath ) );
		if ( file !== root && !file.startsWith( root + path.sep ) ) {
			res.writeHead( 403 );
			res.end();
			return;
		}
		const target = resolveTarget( root, file );
		if ( !target ) {
			res.writeHead( 404, { "Content-Type": "text/html; charset=UTF-8" } );
			res.end( "<h1>Not Found</h1>" );
			return;
		}
		const ext = path.extname( target.file ).toLowerCase();
		if ( ext === ".php" ) {
			const scriptName = urlPath.slice( 0, urlPath.length - target.pathInfo.length );
			runPhpCgi( phpCgi, root, target.file, req, res, scriptName, query,
				target.pathInfo );
			return;
		}
		if ( target.pathInfo ) {
			res.writeHead( 404, { "Content-Type": "text/html; charset=UTF-8" } );
			res.end( "<h1>Not Found</h1>" );
			return;
		}
		res.writeHead( 200, {
			"Content-Type": MIME_TYPES[ ext ] || "application/octet-stream",
			"Content-Length": target.size
		} );
		if ( req.method === "HEAD" ) {
			res.end();
		} else {
			fs.createReadStream( target.file ).pipe( res );
		}
	} );
	return new Promise( function( resolve, reject ) {
		server.once( "error", reject );
		server.listen( port, "127.0.0.1", function() {
			resolve( server );
		} );
	} );
}

async function main() {
	const argv = process.argv.slice( 2 );
	const serve = argv.indexOf( "--serve" ) !== -1;
	let targets = argv.filter( function( arg ) {
		return arg !== "--serve";
	} );
	const overallTimeout = parseInt( process.env.QUNIT_TIMEOUT_MS || "600000", 10 );
	const puppeteer = loadPuppeteer();
	const executablePath = findChrome();

	let server = null;
	let base = "http://127.0.0.1:8000/";
	if ( serve ) {
		// this file lives in test/, so the repository root is its parent
		const root = path.resolve( __dirname, ".." );
		server = await startServer( root, parseInt( process.env.QUNIT_PORT || "0", 10 ) );
		base = "http://127.0.0.1:" + server.address().port + "/";
		console.log( "Serving " + root + " at " + base + " (php-cgi: " +
			( process.env.PHP_CGI || "php-cgi" ) + ")" );
	}
	if ( !targets.length ) {
		targets = [ "test/index.html" ];
	}
	const urls = targets.map( function( target ) {
		return /^https?:\/\//.test( target ) ? target : base + target.replace( /^\//, "" );
	} );

	const browser = await puppeteer.launch( {
		executablePath: executablePath,
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
			"--window-size=1280,1024"
		]
	} );

	const summaries = [];
	let exitCode = 0;
	try {
		for ( const url of urls ) {
			console.log( "Running " + url + " in " + executablePath );
			const result = await runSuite( browser, url, overallTimeout );
			summaries.push( result.summary + "  [" + url + "]" );
			if ( result.code !== 0 ) {
				exitCode = 1;
			}
		}
	} finally {
		await browser.close().catch( function() {} );
		if ( server ) {
			server.close();
		}
	}
	if ( urls.length > 1 ) {
		console.log( "" );
		summaries.forEach( function( line ) {
			console.log( line );
		} );
	}
	return exitCode;
}

async function runSuite( browser, url, overallTimeout ) {
	const page = await browser.newPage();
	await page.setViewport( { width: 1280, height: 1024 } );

	const modules = [];
	const moduleStats = {};
	let testCount = 0;
	let currentTest = null;
	let finalResult = null;
	let settleTimer = null;
	let finish;
	const finished = new Promise( function( resolve ) {
		finish = resolve;
	} );

	page.on( "pageerror", function( err ) {
		console.log( "[page error] " + ( currentTest ? currentTest + ": " : "" ) +
			( err && err.message ? err.message : err ) );
	} );
	page.on( "console", function( msg ) {
		if ( msg.type() === "error" ) {
			console.log( "[console.error] " + msg.text() );
		}
	} );

	await page.exposeFunction( "__qunitReport", function( json ) {
		const event = JSON.parse( json );
		const d = event.data;
		switch ( event.type ) {
		case "testStart":
			currentTest = d.module + " :: " + d.name;
			if ( settleTimer ) {
				// QUnit 1.x may fire done() early between async batches; keep going
				clearTimeout( settleTimer );
				settleTimer = null;
				finalResult = null;
			}
			break;
		case "fail":
			console.log( "FAIL  " + d.module + " :: " + d.name +
				( d.message ? " :: " + d.message : "" ) );
			if ( d.expected !== undefined || d.actual !== undefined ) {
				console.log( "        expected: " + d.expected );
				console.log( "        actual:   " + d.actual );
			}
			if ( d.source ) {
				console.log( "        " + d.source.split( "\n" ).slice( 0, 3 ).join( "\n        " ) );
			}
			break;
		case "testDone":
			testCount++;
			currentTest = null;
			if ( !moduleStats[ d.module ] ) {
				moduleStats[ d.module ] = { tests: 0, failedTests: 0, passed: 0, failed: 0 };
				modules.push( d.module );
			}
			moduleStats[ d.module ].tests++;
			moduleStats[ d.module ].passed += d.passed;
			moduleStats[ d.module ].failed += d.failed;
			if ( d.failed ) {
				moduleStats[ d.module ].failedTests++;
			}
			break;
		case "moduleDone":
			console.log( "Module " + d.name + ": " + d.passed + " passed, " + d.failed +
				" failed, " + d.total + " total" );
			break;
		case "done":
			finalResult = d;
			if ( settleTimer ) {
				clearTimeout( settleTimer );
			}
			settleTimer = setTimeout( function() {
				finish( "done" );
			}, 2000 );
			break;
		}
	} );

	await page.evaluateOnNewDocument( installHooks );

	const timer = setTimeout( function() {
		finish( "timeout" );
	}, overallTimeout );

	await page.goto( url, { waitUntil: "domcontentloaded", timeout: 60000 } );
	const outcome = await finished;
	clearTimeout( timer );

	console.log( "" );
	console.log( "Per-module results:" );
	for ( const name of modules ) {
		const s = moduleStats[ name ];
		console.log( "  " + ( s.failed ? "FAIL" : "ok  " ) + "  " + name + ": " + s.tests +
			" tests (" + s.failedTests + " failing), " + s.passed + " assertions passed, " +
			s.failed + " failed" );
	}
	console.log( "" );

	await page.close().catch( function() {} );

	let summary;
	if ( outcome === "timeout" || !finalResult ) {
		summary = "QUnit: TIMEOUT after " + overallTimeout + "ms" +
			( currentTest ? " while running " + currentTest : "" ) + "; " + testCount +
			" tests completed";
		console.log( summary );
		return { code: 1, summary: summary };
	}

	summary = "QUnit: " + testCount + " tests, " + finalResult.passed +
		" assertions passed, " + finalResult.failed + " failed, total " + finalResult.total;
	console.log( summary + " (" + finalResult.runtime + "ms)" );

	if ( testCount === 0 || finalResult.total === 0 ) {
		console.log( "QUnit: no tests ran" );
		return { code: 1, summary: summary + " (no tests ran)" };
	}
	return { code: finalResult.failed > 0 ? 1 : 0, summary: summary };
}

main().then( function( code ) {
	process.exit( code );
}, function( err ) {
	console.error( err && err.stack ? err.stack : err );
	process.exit( 2 );
} );
