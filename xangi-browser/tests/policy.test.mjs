import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAction,validateUrl,scrub} from '../src/policy.mjs';

test('denies commercial, destructive and submit clicks',()=>{
  for(const name of ['Place order','Pay now','Subscribe','Delete','注文を確定','送信'])
    assert.equal(validateAction({type:'click',name}),'approval_required');
});
test('denies password fields and unknown clicks',()=>{
  assert.equal(validateAction({type:'fill',name:'Password',value:'secret'}),'vault_required');
  assert.equal(validateAction({type:'click'}),'approval_required');
});
test('checks destination allowlist',()=>{
  assert.equal(validateUrl('https://example.org/', ['example.org']),'https://example.org/');
  assert.throws(()=>validateUrl('file:///etc/passwd',['example.org']));
  assert.throws(()=>validateUrl('https://evil.org/',['example.org']));
});
test('filters sensitive snapshot lines',()=>{
  assert.equal(scrub('button Search\ntextbox Password\nbutton Help'),'button Search\nbutton Help');
});
