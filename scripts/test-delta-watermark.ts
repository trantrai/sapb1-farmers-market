// Unit test: logic watermark + delta filter (fm-sync-delta.ts)
// Chạy: npx tsx scripts/test-delta-watermark.ts  (hoặc node với ts-node)
import {
  advanceWatermark,
  deltaFilters,
  dtLit,
  updateDateStr,
  updateTimeNum,
} from '../src/lib/fm-sync-delta'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean) => {
  if (cond) { pass++; console.log(`  PASS ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}

console.log('== dtLit / updateDateStr / updateTimeNum ==')
ok('dtLit', dtLit('2026-10-13') === "datetime'2026-10-13T00:00:00'")
ok('updateDateStr ok', updateDateStr('2026-10-13T00:00:00') === '2026-10-13')
ok('updateDateStr xau', updateDateStr('abc') === '' && updateDateStr(null) === '')
ok('updateTimeNum so', updateTimeNum(143025) === 143025)
ok('updateTimeNum chuoi', updateTimeNum('93025') === 93025)
ok('updateTimeNum xau', updateTimeNum(undefined) === 0 && updateTimeNum('x') === 0)

console.log('== deltaFilters (khong dung or/ngoac) ==')
const [f1, f2] = deltaFilters(`SalesItem eq 'tYES'`, { date: '2026-10-10', time: 90000 })
ok('f1 dung cu phap', f1 === `SalesItem eq 'tYES' and UpdateDate gt datetime'2026-10-10T00:00:00'`)
ok('f2 dung cu phap', f2 === `SalesItem eq 'tYES' and UpdateDate eq datetime'2026-10-10T00:00:00' and UpdateTime gt 90000`)
ok('khong co or/ngoac', !/\bor\b|\(|\)/.test(f1) && !/\bor\b|\(|\)/.test(f2))

console.log('== advanceWatermark ==')
ok('tu null', JSON.stringify(advanceWatermark(null, [{ UpdateDate: '2026-10-13T00:00:00', UpdateTime: 100000 }])) === JSON.stringify({ date: '2026-10-13', time: 100000 }))
// Ngay moi hon thang ngay cu du time nho hon
ok('ngay moi thang', advanceWatermark({ date: '2026-10-13', time: 235959 }, [{ UpdateDate: '2026-10-14T00:00:00', UpdateTime: 1 }]).date === '2026-10-14')
// Cung ngay: time lon hon moi thang
const w1 = advanceWatermark({ date: '2026-10-13', time: 100000 }, [
  { UpdateDate: '2026-10-13T00:00:00', UpdateTime: 90000 },   // cu hon -> bo qua
  { UpdateDate: '2026-10-13T00:00:00', UpdateTime: 120000 },  // moi hon -> thang
])
ok('cung ngay time lon thang', w1.date === '2026-10-13' && w1.time === 120000)
// Bo qua dong thieu UpdateDate
const w2 = advanceWatermark({ date: '2026-10-13', time: 100000 }, [{ UpdateTime: 200000 }, { UpdateDate: 'khong-hop-le', UpdateTime: 200000 }])
ok('bo qua dong thieu moc', w2.date === '2026-10-13' && w2.time === 100000)
// UpdateTime dang chuoi / thieu
const w3 = advanceWatermark(null, [{ UpdateDate: '2026-10-13T00:00:00' }])
ok('thieu UpdateTime -> 0', w3.date === '2026-10-13' && w3.time === 0)

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
