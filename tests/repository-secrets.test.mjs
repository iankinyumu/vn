import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('repository does not track credential-bearing files', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'buffer' })
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map((file) => file.replaceAll('\\', '/'));
    const forbidden = tracked.filter((file) => (
        file === '.env.local'
        || file === '.env'
        || /(^|\/)[^/]*\.pem$/i.test(file)
        || /service_role/i.test(file)
    ));

    assert.deepEqual(forbidden, [], `tracked credential-bearing files: ${forbidden.join(', ')}`);
});
