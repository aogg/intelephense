'use strict';
/**
 * test/helpers/suite.js — 用例汇总器：分组记录 PASS/FAIL + 证据，最终输出汇总与退出码。
 */

class Suite {
  constructor() {
    this.groups = [];
    this.current = null;
  }

  group(name) {
    this.current = { name, cases: [] };
    this.groups.push(this.current);
    console.log(`\n━━ ${name}`);
    const self = this;
    return {
      name,
      it: (caseName, fn) => self.it(caseName, fn),
    };
  }

  /**
   * 记录用例：fn 返回 evidence 字符串 = PASS；返回 {pass, evidence} 按其值；抛错 = FAIL。
   */
  async it(name, fn) {
    const c = { name, pass: false, evidence: '', ms: null };
    const t0 = Date.now();
    try {
      const r = await fn();
      if (r && typeof r === 'object') {
        c.pass = !!r.pass;
        c.evidence = String(r.evidence || '');
      } else {
        c.pass = true;
        c.evidence = String(r === undefined ? '' : r);
      }
    } catch (err) {
      c.pass = false;
      c.evidence = String(err && err.message ? err.message : err);
    }
    c.ms = Date.now() - t0;
    this.current.cases.push(c);
    console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${name} (${c.ms}ms)`);
    if (c.evidence) console.log(`         证据: ${c.evidence}`);
    return c;
  }

  totals() {
    let pass = 0;
    let fail = 0;
    for (const g of this.groups) for (const c of g.cases) (c.pass ? pass++ : fail++);
    return { pass, fail, total: pass + fail };
  }

  printSummary() {
    const { pass, fail, total } = this.totals();
    console.log('\n==== T5 独立协议级验证汇总 ====');
    for (const g of this.groups) {
      const gp = g.cases.filter((c) => c.pass).length;
      console.log(`  ${g.name}: ${gp}/${g.cases.length}`);
      for (const c of g.cases.filter((x) => !x.pass)) {
        console.log(`    [FAIL] ${c.name}`);
        console.log(`       证据: ${c.evidence}`);
      }
    }
    console.log(`合计: ${pass}/${total} 通过，${fail} 失败`);
    return fail === 0 ? 0 : 1;
  }
}

module.exports = { Suite };
