'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const R=require('../docs/page-rotation.js');
test('Arbitrary and quarter-turn transforms fit the canvas and round-trip to source pixels',()=>{
  for(const [w,h]of [[1200,600],[3001,1501],[1810,2560],[1,10]]){
    for(const angle of [-360,-359.99,-135,-90,-6.25,-.01,0,.01,6.25,45,89.99,90,135,180,270,359.99,360]){
      const view=R.geometry(w,h,angle);
      assert(view.width<=2560&&view.height<=2560);
      for(const point of [[0,0],[w,0],[w,h],[0,h],[w/2,h/2],[w*.12,h*.83]]){
        const output=R.forward(point,view),restored=R.inverse(output,view);
        assert(output[0]>=-1e-8&&output[0]<=view.width+1e-8);
        assert(output[1]>=-1e-8&&output[1]<=view.height+1e-8);
        assert(Math.abs(restored[0]-point[0])<1e-8&&Math.abs(restored[1]-point[1])<1e-8);
      }
    }
  }
});
test('Quarter-turn corners are exact; tiny rotations retain decimal precision',()=>{
  const v=R.geometry(1200,600,90);
  assert.deepEqual(R.forward([0,0],v),[600,0]);
  assert.deepEqual(R.forward([1200,600],v),[0,1200]);
  assert.equal(R.normalize(-3.25),356.75);assert.equal(R.normalize(360),0);
  assert.equal(R.normalize(.01),.01);
});
test('Invalid and excessive angles are rejected before changing the page',()=>{
  for(const angle of [NaN,Infinity,-Infinity,-361,361,'3',null,undefined])assert.throws(()=>R.normalize(angle));
  for(const dimensions of [[0,1],[1,0],[-1,1],[Infinity,1]])assert.throws(()=>R.geometry(...dimensions,0));
});
