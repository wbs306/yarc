import assert from 'node:assert/strict'
import test from 'node:test'
import katex from 'katex'
import { mathAtPosition, scanLatexMath } from './latex-math'

for (const [open, close, display] of [
  ['$', '$', false], ['$$', '$$', true],
  ['\\(', '\\)', false], ['\\[', '\\]', true],
] as const) {
  test(`recognizes ${open}…${close} and cursor boundaries`, () => {
    const text = `before ${open}x^2${close} after`
    const [range] = scanLatexMath(text)
    assert.equal(range.source, 'x^2')
    assert.equal(range.complete, true)
    assert.equal(range.display, display)
    assert.equal(mathAtPosition([range], range.from), range)
    assert.equal(mathAtPosition([range], range.to), range)
    assert.equal(mathAtPosition([range], range.from - 1), undefined)
    assert.equal(mathAtPosition([range], range.to + close.length), undefined)
  })
}

for (const environment of ['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'math']) {
  test(`supports ${environment} with renderable source`, () => {
    const body = environment.startsWith('align') ? 'a &= b \\\\ c &= d' : 'x^2'
    const [range] = scanLatexMath(`\\begin{${environment}}${body}\\end{${environment}}`)
    assert.equal(range.complete, true)
    assert.equal(range.display, environment !== 'math')
    assert.doesNotThrow(() => katex.renderToString(range.source, { throwOnError: true, displayMode: range.display }))
  })
}

test('comments, escaped dollars and escaped percent signs are distinguished', () => {
  const ranges = scanLatexMath('cost \\$5 % $ignored$\n\\% $x + \\$ + \\%$ and $y$')
  assert.deepEqual(ranges.map(range => range.source), ['x + \\$ + \\%', 'y'])
})

test('comments inside math cannot close its delimiter', () => {
  const [range] = scanLatexMath('$$x % $$ not a closing token\n+y$$')
  assert.equal(range.complete, true)
  assert.equal(range.source, 'x % $$ not a closing token\n+y')
})

test('skips verbatim environments and inline verbatim', () => {
  const ranges = scanLatexMath('\\verb|$ignored$| \\verb*+$also ignored$+ \\begin{minted}{tex}$no$\\end{minted} $yes$')
  assert.deepEqual(ranges.map(range => range.source), ['yes'])
})

test('nested environments are preserved within the outer equation', () => {
  const source = '\\begin{split}a &= b \\\\ c &= d\\end{split}'
  const [range] = scanLatexMath(`\\begin{equation}${source}\\end{equation}`)
  assert.equal(range.source, source)
  assert.equal(range.complete, true)
})

test('unfinished formulas have a temporary range, bounded by a blank line', () => {
  const text = 'before \\[x^2\n\nordinary prose'
  const [range] = scanLatexMath(text)
  assert.equal(range.source, 'x^2')
  assert.equal(range.complete, false)
  assert.equal(mathAtPosition([range], text.length), undefined)
  assert.equal(scanLatexMath('$')[0].source, '')
})

test('handles multiline inline math and multiple independent formulas', () => {
  assert.deepEqual(scanLatexMath('$a\n+b$ then \\(c\\)').map(range => range.source), ['a\n+b', 'c'])
})

test('adjacent inline formulas are not mistaken for display math', () => {
  assert.deepEqual(scanLatexMath('$x$$y$').map(range => range.source), ['x', 'y'])
})

test('an unfinished align comment does not consume the synthetic closing environment', () => {
  const [range] = scanLatexMath('\\begin{align}x &= 1 % typing a comment')
  assert.equal(range.complete, false)
  assert.doesNotThrow(() => katex.renderToString(range.source, { throwOnError: true, displayMode: true }))
})

test('bounds excessively large formulas', () => {
  const [range] = scanLatexMath('\\[' + 'x'.repeat(9000))
  assert.equal(range.source.length, 8000)
  assert.equal(range.complete, false)
})
