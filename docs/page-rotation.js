'use strict';
// One affine transform is shared by preview rendering and OCR coordinate mapping.
(function(root){
  function normalize(angle){
    if(typeof angle!=='number'||!Number.isFinite(angle)||Math.abs(angle)>360)throw Error('請輸入 -360 到 360 度之間的旋轉角度。');
    return ((Math.round(angle*1000000)%360000000)+360000000)%360000000/1000000;
  }
  function geometry(sourceWidth,sourceHeight,angle,maxSide=2560){
    if(![sourceWidth,sourceHeight,maxSide].every(n=>Number.isFinite(n)&&n>0))throw Error('頁面尺寸不正確。');
    const rotation=normalize(angle),quarter=rotation/90;
    const c=Number.isInteger(quarter)?[1,0,-1,0][quarter]:Math.cos(rotation*Math.PI/180);
    const s=Number.isInteger(quarter)?[0,1,0,-1][quarter]:Math.sin(rotation*Math.PI/180);
    const boundsWidth=Math.ceil(Math.abs(sourceWidth*c)+Math.abs(sourceHeight*s));
    const boundsHeight=Math.ceil(Math.abs(sourceWidth*s)+Math.abs(sourceHeight*c));
    const scale=Math.min(1,maxSide/boundsWidth,maxSide/boundsHeight);
    const width=Math.max(1,Math.min(maxSide,Math.ceil(boundsWidth*scale-1e-9)));
    const height=Math.max(1,Math.min(maxSide,Math.ceil(boundsHeight*scale-1e-9)));
    const a=c*scale,b=s*scale,cc=-s*scale,d=c*scale;
    const matrix=[a,b,cc,d,width/2-a*sourceWidth/2-cc*sourceHeight/2,height/2-b*sourceWidth/2-d*sourceHeight/2];
    return {sourceWidth,sourceHeight,rotation,width,height,matrix};
  }
  function forward([x,y],view){const [a,b,c,d,e,f]=view.matrix;return [a*x+c*y+e,b*x+d*y+f];}
  function inverse([x,y],view){const [a,b,c,d,e,f]=view.matrix,det=a*d-b*c;return [(d*(x-e)-c*(y-f))/det,(-b*(x-e)+a*(y-f))/det];}
  const api=Object.freeze({normalize,geometry,forward,inverse});
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PageRotation=api;
})(globalThis);
