import fs from 'fs';

const files = process.argv.slice(2);

if (files.length === 0) {
    console.log('Usage: node print_aggregated_errors.js errors_*.json');
    process.exit(0);
}

let totalErrors = 0;

for (const file of files) {
    let data;
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        console.error(`Failed to parse ${file}: ${err.message}`);
        continue;
    }

    const match = file.match(/errors_([\w_]+)\.json/);
    const nodeName = match ? match[1].replace(/_/g, ' ') : file;

    const aggregated = data.aggregated || {};
    const services = data.services || {};
    const errorCount = Object.values(aggregated).reduce((sum, c) => sum + c, 0);
    totalErrors += errorCount;

    if (errorCount === 0) {
        console.log(`\n${nodeName}: No errors`);
        continue;
    }

    console.log(`\n${nodeName}: ${errorCount} total error(s)`);

    // Group by service
    const byService = {};
    for (const [msg, count] of Object.entries(aggregated)) {
        const svc = services[msg] || 'other';
        if (!byService[svc]) byService[svc] = [];
        byService[svc].push({ msg, count });
    }

    for (const [svc, entries] of Object.entries(byService)) {
        const svcTotal = entries.reduce((sum, e) => sum + e.count, 0);
        console.log(`  [${svc}] (${svcTotal})`);
        for (const { msg, count } of entries) {
            console.log(`    ${count}x ${msg}`);
        }
    }
}

console.log(`\n--- Grand total: ${totalErrors} error(s) across ${files.length} file(s)`);
