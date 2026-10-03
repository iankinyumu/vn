// Engine v3 worker (ADR 0002 D1). The only component that ever holds a seed.
// Each cycle: heartbeat + clock check; register config; commit and witness
// upcoming epochs; publish due ticks in order; checkpoint; reveal finished
// epochs; activate due cutovers. Every write goes through an engine_v3_* RPC
// that re-checks sequence, schedule, chain and hash in the database.
import { randomBytes } from 'node:crypto';
import * as g from '../generator.mjs';
import { seedContext } from './custody.mjs';

const DAY = 86_400_000n;
const hexBuf = (hex) => Buffer.from(hex, 'hex');
const sqlCode = (error) => String(error?.message || '').match(/engine_[a-z0-9_]+|feed_stale|index_not_available/)?.[0];

export class EngineWorker {
    /**
     * @param {object} o
     * @param {{query:Function}} o.db  connection as a member of engine_tick_writer
     * @param {'DEMO'|'REAL'} o.mode
     * @param {object} o.params  per-index model parameters (annual_vol_bp, anchor_units, kappa_e12, min_units, max_units, genesis_tick_no, genesis_units)
     * @param {object} o.custody LocalCustody | AwsKmsCustody
     * @param {object} o.signer  Ed25519Signer
     * @param {Array}  o.witnesses providers with {name, witness(subject)}
     */
    constructor({ db, mode = 'DEMO', workerId = 'engine-v3-worker', params, custody, signer, witnesses, clock = () => Date.now(), log = () => {},
        checkpointEvery = 150, commitAheadEpochs = 2, maxTicksPerCycle = 50, resumeGiveUpMs = 120_000, runtime = `node ${process.version}` }) {
        Object.assign(this, { db, mode, workerId, params, custody, signer, witnesses, clock, log, checkpointEvery, commitAheadEpochs, maxTicksPerCycle, resumeGiveUpMs, runtime });
        this.keys = new Map();      // `${epoch}:${index}` -> {move, digit}; current/past epochs only
        this.stopped = false;
    }

    async rpc(name, args) {
        const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
        const { rows } = await this.db.query(`select public.${name}(${placeholders}) as result`, args);
        return rows[0].result;
    }

    async acquireLeadership() {
        const { rows } = await this.db.query(`select pg_try_advisory_lock(hashtextextended('engine-v3-worker:'||$1,0)) as ok`, [this.mode]);
        return rows[0].ok;
    }

    async registerSigningKey() { await this.rpc('engine_v3_register_signing_key', [this.signer.keyId, this.signer.publicKey]); }

    async cycle() {
        const report = { published: 0, duplicates: 0, committed: 0, witnessed: 0, checkpoints: 0, revealed: 0, activated: 0, errors: [] };
        const dbNow = BigInt(await this.rpc('engine_v3_heartbeat', [this.workerId, String(this.clock()), this.custody.provider, this.runtime]));
        const state = await this.rpc('engine_v3_writer_state', [this.mode]);
        const drift = BigInt(this.clock()) - dbNow;
        if ((drift < 0n ? -drift : drift) > BigInt(state.settings.max_clock_drift_ms)) {
            report.errors.push('clock_drift');
            this.log('warn', 'clock drift beyond policy; not publishing', { drift: String(drift) });
            return report;
        }
        this.state = state;
        this.env = state.env;
        this.plan = await this.rpc('engine_v3_resume_plan', [this.mode]);
        await this.ensureCommitments(state, report);
        await this.ensureWitnesses(report);
        for (const index of this.state.indices) {
            const resuming = this.openResume(index.index)?.status === 'committed';
            if ((index.halted && !resuming) || !(index.generation === 3 || index.shadow)) continue;
            try { await this.publishDue(index, report); } catch (error) { report.errors.push(`${index.index}:${sqlCode(error) || error.message}`); this.log('error', 'publish failed', { index: index.index, error: error.message }); }
        }
        await this.checkpoints(report);
        await this.reveals(report);
        await this.cutovers(report);
        this.forgetOldKeys(BigInt(this.state.now_ms));
        return report;
    }

    // Open (scheduled or committed) resume for an index, if any (ADR 0001 §5.6).
    openResume(index) { return (this.plan || []).find((r) => r.index === index) || null; }

    // A running v3 index keeps the genesis of its latest committed configuration; the
    // database refuses any other change except a scheduled resume, whose genesis is
    // the paused price scaled by 10^exponent. Returns null while a resume in this
    // epoch still waits for its pause tick.
    genesisFor(row, epochStart, latestEntries) {
        const resume = this.openResume(row.index);
        if (resume?.status === 'scheduled' && BigInt(resume.epoch_start_ms) === epochStart) {
            if (!row.last || row.last.tick_no !== resume.pause_after_tick_no) return null;
            return { genesis_tick_no: resume.genesis_tick_no, genesis_units: g.rescaleUnits(BigInt(row.last.price_units), BigInt(resume.exponent)).toString() };
        }
        const current = row.generation === 3 ? latestEntries?.find((e) => e.index === row.index) : null;
        const p = this.params[row.index];
        return current ? { genesis_tick_no: String(current.genesis_tick_no), genesis_units: String(current.genesis_units) }
            : { genesis_tick_no: String(p.genesis_tick_no), genesis_units: String(p.genesis_units) };
    }

    entriesFor(state, epochStart, committedEntries = null) {
        const latest = [...(state.epochs || [])].sort((a, b) => (BigInt(a.epoch_start_ms) < BigInt(b.epoch_start_ms) ? -1 : 1)).at(-1);
        const latestEntries = committedEntries || (latest ? state.configs?.[latest.config_hash] : null);
        const entries = [];
        for (const row of state.indices) {
            const p = this.params[row.index];
            if (!p) throw new Error(`engine_v3_params_missing_${row.index}`);
            const genesis = this.genesisFor(row, epochStart, latestEntries);
            if (!genesis) return null;
            entries.push({
                index: row.index, annual_vol_bp: p.annual_vol_bp, tick_interval_ms: row.tick_interval_ms, decimals: row.decimals,
                anchor_units: String(p.anchor_units), sigma_e12: g.sigmaE12(p.annual_vol_bp, row.tick_interval_ms).toString(), kappa_e12: String(p.kappa_e12),
                min_units: String(p.min_units), max_units: String(p.max_units), t0_ms: row.t0_ms, ...genesis,
            });
        }
        return entries;
    }

    async registerConfig(state, entries) {
        const local = g.configHash({ env: state.env, mode: this.mode, indices: entries }).toString('hex');
        const remote = (await this.rpc('engine_v3_register_config', [this.mode, JSON.stringify(entries)])).toString('hex');
        if (local !== remote) throw new Error('engine_v3_config_hash_disagrees'); // SQL and Node must agree byte for byte
        return local;
    }

    async ensureCommitments(state, report) {
        const now = BigInt(state.now_ms);
        const lead = BigInt(state.settings.min_commit_lead_ms);
        let latest = state.latest_commitment;
        const today = now / DAY * DAY;
        let next = latest ? BigInt(latest.epoch_start_ms) + DAY : (now <= today - lead ? today : today + DAY);
        let committedEntries = null;
        for (; next <= today + DAY * BigInt(this.commitAheadEpochs); next += DAY) {
            if (now > next - lead) { this.log('error', 'epoch missed its commitment window', { epoch: String(next) }); report.errors.push(`missed_epoch:${next}`); break; }
            let entries = this.entriesFor(state, next, committedEntries);
            if (!entries) {
                // A resume in this epoch is waiting for its pause tick. Give up on it shortly
                // before the commitment window closes so every other index keeps running.
                if (now <= next - lead - BigInt(this.resumeGiveUpMs)) break;
                for (const r of this.plan.filter((item) => item.status === 'scheduled' && BigInt(item.epoch_start_ms) === next)) {
                    await this.rpc('engine_v3_miss_resume', [this.mode, r.index, 'pause tick not published before the commitment window']);
                    report.errors.push(`resume_missed:${r.index}`);
                }
                this.plan = await this.rpc('engine_v3_resume_plan', [this.mode]);
                entries = this.entriesFor(state, next, committedEntries);
                if (!entries) break;
            }
            const configHash = await this.registerConfig(state, entries);
            const seed = randomBytes(32);
            try {
                const seedHash = g.seedHash(seed);
                const prev = latest ? hexBuf(latest.commitment) : Buffer.alloc(32);
                const commitment = g.epochCommitment({ env: state.env, mode: this.mode, epochStartMs: next, seedHash, configHash, prevCommitment: prev });
                const wrapped = await this.custody.wrap(seed, seedContext({ env: state.env, mode: this.mode, epochStartMs: next }));
                await this.rpc('engine_v3_commit_epoch', [this.mode, String(next), hexBuf(configHash), seedHash, prev, commitment,
                    this.signer.keyId, this.signer.sign('epoch-commitment', commitment), this.custody.provider, wrapped.keyRef, wrapped.ciphertext]);
                latest = { epoch_start_ms: String(next), commitment: commitment.toString('hex') };
                committedEntries = entries;
                report.committed++;
            } finally { seed.fill(0); }
        }
        this.state = await this.rpc('engine_v3_writer_state', [this.mode]);
        if (committedEntries) this.plan = await this.rpc('engine_v3_resume_plan', [this.mode]);
    }

    async witnessSubject(kind, subject, have, report) {
        for (const provider of this.witnesses) {
            if (have.includes(provider.name)) continue;
            try {
                const receipt = await provider.witness(subject);
                await this.rpc('engine_v3_record_witness', [kind, subject, receipt.provider, receipt.token, new Date(receipt.genTimeMs).toISOString()]);
                report.witnessed++;
            } catch (error) {
                report.errors.push(`witness:${provider.name}`);
                this.log('warn', 'witness failed; will retry', { provider: provider.name, error: error.message });
            }
        }
    }

    async ensureWitnesses(report) {
        for (const epoch of this.state.epochs) {
            if (!epoch.revealed) await this.witnessSubject('epoch-commitment', hexBuf(epoch.commitment), epoch.witnesses, report);
        }
        for (const cp of this.state.unwitnessed_checkpoints) await this.witnessSubject('checkpoint', hexBuf(cp.checkpoint_hash), cp.witnesses, report);
    }

    epochFor(start) { return this.state.epochs.find((epoch) => BigInt(epoch.epoch_start_ms) === start); }

    async keysFor(epochStart, index) {
        const cacheKey = `${epochStart}:${index}`;
        if (this.keys.has(cacheKey)) return this.keys.get(cacheKey);
        const { rows } = await this.db.query('select * from public.engine_v3_wrapped_seed($1,$2)', [this.mode, String(epochStart)]);
        if (!rows.length) throw new Error('engine_v3_seed_unavailable');
        const seed = await this.custody.unwrap({ keyRef: rows[0].key_ref, ciphertext: rows[0].ciphertext }, seedContext({ env: this.env, mode: this.mode, epochStartMs: epochStart }));
        try {
            const common = { env: this.env, mode: this.mode, index, epochStartMs: epochStart };
            const pair = { move: g.deriveKey(seed, { ...common, purpose: 'price-move' }), digit: g.deriveKey(seed, { ...common, purpose: 'price-digit' }) };
            this.keys.set(cacheKey, pair);
            return pair;
        } finally { seed.fill(0); }
    }

    forgetOldKeys(now) {
        const today = now / DAY * DAY;
        for (const key of this.keys.keys()) if (BigInt(key.split(':')[0]) < today - DAY) this.keys.delete(key);
    }

    entryFor(epoch, index) {
        const raw = this.state.configs[epoch.config_hash]?.find((e) => e.index === index);
        if (!raw) throw new Error('engine_v3_config_missing');
        const numeric = ['annual_vol_bp', 'tick_interval_ms', 'decimals', 'anchor_units', 'sigma_e12', 'kappa_e12', 'min_units', 'max_units', 't0_ms', 'genesis_tick_no', 'genesis_units'];
        return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, numeric.includes(k) ? BigInt(v) : v]));
    }

    async publishDue(row, report) {
        const now = BigInt(this.clock());
        const t0 = BigInt(row.t0_ms), interval = BigInt(row.tick_interval_ms);
        const due = (now - t0) / interval;
        let lastNo, lastUnits, lastHash;
        if (row.last) {
            lastNo = BigInt(row.last.tick_no); lastUnits = BigInt(row.last.price_units); lastHash = hexBuf(row.last.tick_hash);
        } else {
            // Genesis comes from the configuration committed for the first v3 tick's epoch.
            const genesisNo = BigInt(this.params[row.index].genesis_tick_no);
            const epoch = this.epochFor((t0 + (genesisNo + 1n) * interval) / DAY * DAY);
            if (!epoch) return;
            const entry = this.entryFor(epoch, row.index);
            lastNo = entry.genesis_tick_no; lastUnits = entry.genesis_units;
            lastHash = g.genesisHash({ env: this.env, mode: this.mode, entry, configHash: hexBuf(epoch.config_hash) });
        }
        let limit = lastNo + BigInt(this.maxTicksPerCycle);
        for (let tickNo = lastNo + 1n; tickNo <= due && tickNo <= limit; tickNo++) {
            const resume = this.openResume(row.index);
            if (resume && row.generation === 3 && tickNo > BigInt(resume.pause_after_tick_no) && tickNo <= BigInt(resume.genesis_tick_no)) {
                // Announced pause (ADR 0001 §5.6): nothing is produced until the resume's
                // genesis, and only once its configuration is committed.
                const genesisNo = BigInt(resume.genesis_tick_no);
                if (resume.status !== 'committed' || lastNo !== BigInt(resume.pause_after_tick_no) || genesisNo + 1n > due) break;
                const epoch = this.epochFor((t0 + (genesisNo + 1n) * interval) / DAY * DAY);
                if (!epoch) break;
                const entry = this.entryFor(epoch, row.index);
                if (entry.genesis_tick_no !== genesisNo) break;
                lastNo = genesisNo; lastUnits = entry.genesis_units;
                lastHash = g.genesisHash({ env: this.env, mode: this.mode, entry, configHash: hexBuf(epoch.config_hash) });
                tickNo = genesisNo + 1n;
                limit = lastNo + BigInt(this.maxTicksPerCycle);
            }
            const scheduled = t0 + tickNo * interval;
            const epochStart = scheduled / DAY * DAY;
            const epoch = this.epochFor(epochStart);
            if (!epoch) { report.errors.push(`${row.index}:engine_v3_epoch_uncommitted`); break; }
            const entry = this.entryFor(epoch, row.index);
            const keys = await this.keysFor(epochStart, row.index);
            let drawn;
            try { drawn = g.generateTick({ keys, entry, tickNo, prevUnits: lastUnits }); }
            catch (error) {
                const reason = { engine_v3_price_out_of_band: 'price band breach', engine_v3_move_out_of_bound: 'move limit breach' }[error.message];
                if (!reason) throw error;
                // Never reroll or clamp (ADR 0001 §5.4, §5.7): halt, refund, report. A move
                // limit breach cannot come from the model, so it means a fault.
                await this.rpc('engine_v3_halt', [this.mode, row.index, `${reason} at tick ${tickNo}`]);
                if (row.generation === 3) await this.rpc('engine_v3_void_unproducible', [this.mode, row.index, reason]);
                throw error;
            }
            const tick = {
                env: this.env, mode: this.mode, index: row.index, tick_no: tickNo, scheduled_ms: scheduled, generated_ms: BigInt(this.clock()), epoch_start_ms: epochStart,
                prev_units: lastUnits, price_units: drawn.units, decimals: Number(entry.decimals), digit: drawn.digit,
                config_hash: hexBuf(epoch.config_hash), commitment: hexBuf(epoch.commitment), prev_tick_hash: lastHash,
            };
            tick.tick_hash = g.tickHash(tick);
            let outcome;
            try {
                outcome = await this.rpc('engine_v3_publish_tick', [this.mode, row.index, String(tickNo), String(scheduled), String(tick.generated_ms),
                    String(lastUnits), String(drawn.units), drawn.digit, tick.tick_hash]);
            } catch (error) {
                if (sqlCode(error) !== 'engine_v3_tick_conflict') throw error;
                // An earlier attempt was stored but its reply was lost. The stored
                // record is authoritative; it must carry the same price we derived.
                const fresh = (await this.rpc('engine_v3_writer_state', [this.mode])).indices.find((item) => item.index === row.index);
                if (fresh?.last?.tick_no !== String(tickNo) || fresh.last.price_units !== String(drawn.units)) {
                    this.stopped = true;
                    throw new Error('engine_v3_nondeterminism_detected');
                }
                tick.tick_hash = hexBuf(fresh.last.tick_hash);
                outcome = 'duplicate';
            }
            if (outcome === 'duplicate') report.duplicates++; else report.published++;
            lastNo = tickNo; lastUnits = drawn.units; lastHash = tick.tick_hash;
            row.last = { tick_no: String(tickNo), price_units: String(drawn.units), tick_hash: lastHash.toString('hex') };
        }
    }

    async checkpoints(report) {
        for (const row of this.state.indices) {
            if (!row.last || !(row.generation === 3 || row.shadow)) continue;
            const last = BigInt(row.last.tick_no);
            const previous = row.last_checkpoint_tick_no ? BigInt(row.last_checkpoint_tick_no) : null;
            const genesis = BigInt(this.params[row.index].genesis_tick_no);
            if (last - (previous ?? genesis) < BigInt(this.checkpointEvery)) continue;
            const createdMs = BigInt(this.clock());
            const hash = g.checkpointHash({ env: this.env, mode: this.mode, index: row.index, tickNo: last, tickHash: hexBuf(row.last.tick_hash), createdMs });
            await this.rpc('engine_v3_publish_checkpoint', [this.mode, row.index, String(last), String(createdMs), hash, this.signer.keyId, this.signer.sign('checkpoint', hash)]);
            row.last_checkpoint_tick_no = String(last);
            report.checkpoints++;
            await this.witnessSubject('checkpoint', hash, [], report);
        }
    }

    async reveals(report) {
        const now = BigInt(this.state.now_ms), delay = BigInt(this.state.settings.reveal_delay_ms);
        for (const epoch of this.state.epochs) {
            const start = BigInt(epoch.epoch_start_ms);
            if (epoch.revealed || now < start + DAY + delay) continue;
            const { rows } = await this.db.query('select * from public.engine_v3_wrapped_seed($1,$2)', [this.mode, String(start)]);
            if (!rows.length) continue;
            const seed = await this.custody.unwrap({ keyRef: rows[0].key_ref, ciphertext: rows[0].ciphertext }, seedContext({ env: this.env, mode: this.mode, epochStartMs: start }));
            try { await this.rpc('engine_v3_reveal_epoch', [this.mode, String(start), seed]); report.revealed++; }
            catch (error) { if (sqlCode(error) !== 'engine_v3_reveal_blocked_by_open_contracts') throw error; }
            finally { seed.fill(0); }
        }
    }

    async cutovers(report) {
        const now = BigInt(this.state.now_ms);
        for (const row of this.state.indices) {
            if (row.generation !== 2 || !row.v2_final_tick_no || now < BigInt(row.cutover_ms) || row.state_last_tick_no !== row.v2_final_tick_no) continue;
            try { await this.rpc('engine_v3_activate_cutover', [this.mode, row.index]); report.activated++; }
            catch (error) { report.errors.push(`cutover:${row.index}:${sqlCode(error) || error.message}`); }
        }
    }
}
