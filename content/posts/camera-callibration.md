+++ 
draft = false
date = 2025-01-18T22:13:31+05:30
title = "Camera Callibration"
description = "An introduction to the technique of camera callibration using Zhang's Algorithm"
slug = ""
authors = ["Zuhaib Ul Zamann"]
tags = ["Zhang's Algorithm"]
categories = ["Computer Vision", "Camera Callibration"]
externalLink = ""
series = []
[params]
    katex = true
+++
## Table of Contents
1. [Introduction](#Introduction)
2. [Pinhole Camera](#pinhole-camera)
3. [Homogeneous Coordinate System](#homogeneous-coordinate-system)
    1. [Homogeneous Image Coordinate system](#homogeneous-image-coordinate-system)
    2. [Homogeneous World Coordinate System](#homogeneous-world-coordinate-system) 
4. [Mathematics of Camera Projection](#mathematics-of-camera-projection)
5. [Real Projection Plane](#real-projective-plane)
6. [Homography](#homography)
7. [Direct Linear Transform](#direct-linear-transform)
8. [Zhang's Algorithm](#zhangs-algorithm)

## Introduction
In this blog, we will know about a basic pinhole camera. We will know what camera matrix is, what are intrinsic and extrinsic parameters. We will also learn how we can find these parameters and will also provide an implementation in python for the same.

So let us start

## Pinhole Camera
In a pinhole camera light enters through a small aperture (known as pinhole) and is projected inside of the light proof box forming an inverted image on the image plane.

It can be mathematically modeled as shown below
![Pinhole Camera](/images/pinhole_camera.jpg)

Assuming the world coordinate frame be centered(origin) at the camera center and the image plane(or the focal plane) being $Z = f$ a point $(X, Y, Z)$ is mapped to a point $(x, y, f)$ such that the line joining $(X, Y, Z)$ and $(x, y, f)$ passes through the camera center (in this case,  origin).
Since $(0, 0,0), (X, Y, Z), (x, y, f)$ all lie on the same line, we have $(x, y, f) = \lambda (X, Y, Z) + (0, 0, 0)$

Simplifying, we get

$$x = \lambda X, y = \lambda Y, f = \lambda Z$$

$$\Rightarrow \lambda = \frac{f}{Z}$$

Hence, we have $x = \frac{X}{Z}f, y = \frac{Y}{Z}f$

In the above expression, we assumed that the origin of the image plane coordinate system lies at P(Principal point), which may not be true in general(Often in image coordinates, we consider the top left corner of the image as being the origin).

Hence if the coordinates of principal point are $(p_x, p_y)$, then the equations are given by $x = \frac{X}{Z}f + p_x, y = \frac{Y}{Z}f + p_y$

## Homogeneous Coordinate system
Consider two points $(X_1, Y_1, Z_1)$ and $(X_2, Y_2, Z_2)$ in $3D$ coordinate system. Suppose we identify the points $(X_1, Y_1, Z_1)$ and $(X_2, Y_2, Z_2)$ being equal if $\frac{X_1}{Z_1} = \frac{X_2}{Z_2}$ and $\frac{Y_1}{Z_1} = \frac{Y_2}{Z_2}$. Such a coordinate system is known  as $3D$ homogeneous coordinate system. 

In homogeneous coordinate system two point $A$ and $B$ are equal if there exists a scalar $k$ such that $kA = B$ in real coordinate system.

We will use homogeneous coordinate system in the rest of the calculations from now on.

### Homogeneous Image Coordinate system
We convert our $2D$ image coordinate system to $3D$ homogeneous coordinate system by mapping point $(x, y)$ to $(x, y, 1)$. Furthermore, we write any coordinate as a column matrix. Hence the point $(x, y)$ in image coordinates will be written as



$$\begin{bmatrix}x\\\\y\\\\1\end{bmatrix}$$

### Homogeneous World Coordinate system
Similar to that Image coordinate system, we will convert our world coordinate system to a homogeneous coordinate system by mapping point $(X, Y, Z)$ in 3D world coordinates to $(X, Y, Z, 1)$ in 4D homogeneous coordinates. 

It is easy to observe that we can move from one coordinate system to other coordinate system very easily e.g. a point $(6, 8, 4, 2)$ in homogeneous world coordinate system represents the point $(\frac{6}{2}, \frac{8}{2}, \frac{4}{2}) =  (3, 4, 2)$ in world coordinate system.

By using, homogeneous coordinate system, the mathematics of camera projection becomes linear.

## Mathematics of camera projection
As we saw above, a point $X, Y, Z$ in world coordinate system is mapped to the point $x = \frac{X}{Z}f + p_x, y = \frac{Y}{Z}f + p_y$ in image coordinate system.

If we take the homogeneous versions of both the systems, then we can say that the point $(X, Y, Z, 1)$ is mapped to the point $(fX +Zp_x. fY + Zp_y , Z)$.

This mapping can be written as

$$\begin{bmatrix}x \\\\ y \\\\ z \end{bmatrix} = \begin{bmatrix}f & 0 & p_x & 0 \\\\ 0 & f&p_y &0 \\\\ 0&0&1&0\end{bmatrix}\begin{bmatrix}X\\\\ Y\\\\ Z\\\\ 1\end{bmatrix}$$

Writing $$K = \begin{bmatrix}f & 0 & p_x\\\\ 0 & f & p_y \\\\ 0 & 0 & 1\end{bmatrix}$$

$$\textbf{X}_{\text{cam}} = \begin{bmatrix}X \\\\ Y \\\\ Z \\\\ 1\end{bmatrix}$$


$$\textbf{x} = \begin{bmatrix}x \\\\ y\\\\z \end{bmatrix}$$

then the above expression takes the form

$$\textbf{x} = K[I\vert 0]X_{\text{cam}}$$

Now in all of the above expressions, we have assumed that the world coordinate system is the camera coordinate system, which may not be true. However we can map any world coordinate system to the camera coordinate system by the simple expression $\textbf{X}_{\text{cam}} = R(\textbf{X} - \textbf{C})|$ where $R$ is a $3\times 3$ rotation matrix and $C$ are the world coordinates of the camera center.

This equation in homogeneous coordinates can be written as 

$$\textbf{X}_{\text{cam}} = \begin{bmatrix}R & -RC\\\\ 0 & 1\end{bmatrix}\textbf{X}$$

Hence in any general setup, the mapping between the world coordinates and the image coordinates by a pinhole camera reads as

$$x = KR[I\vert -C]X$$
Camera callibration is the process of determining the matrix vectors K, R and C of a particular camera. The matrix $K$ depends only on the camera (and are known as camera intrinsic parameters) where as $R$ and $C$ depend on the coordinate system of choice(and are known as extrinsic parameters)
**CCD Camera**: In CCD camera's it is possible to have unequal scale in x and y directions. In that case the camera matrix K becomes
$$\begin{bmatrix}f_x & 0 & p_x \\\\ 0 & f_y & p_y \\\\ 0 & 0 & 1\end{bmatrix}$$
The most generic form of matrix $K$ is $$K = \begin{bmatrix}f_x & s & p_x \\\\ 0 & f_y & p_y \\\\ 0 & 0 & 1\end{bmatrix}$$ where $s$ is the skew parameter(generally 0 in most matrices).

## Real Projective Plane
The transformation of 2D real world system to the homogenous coordinate system can be thought of as identifying a point in $\mathbb{R}^2$ with a ray passing through origin in $\mathbb{R}^3$ in the sense that $(x_1, x_2) \longleftrightarrow \\{ (kx_1, kx_2, k): k\in \mathbb{R} \\}$.
However we will be missnig the set of the points in $(x_1, x_2, 0)\in \mathbb{R^3}$ in this representation. If we include the set of the points $(x_1, x_2, 0)$ also in the representation where $(x_1, x_1, 0)$ and $(y_1, y_2, 0)$ will be lying on the same ray  if $x_1:x_2 :: y_2:y_2$ then the corresponding geometry that we get is known as projective geometry and is denoted as $\mathbb{P}^2$.
A point in $\mathbb{P}^2$ corresponds to a line in $\mathbb{R}^3$ which passes through origin. A line in $\mathbb{P}^2$ corresponds to a plane in $\mathbb{R}^3$

Since the points in $\mathbb{P}^2$ denoted lines passing through origin in $\mathbb{R}^3$, any plane passing through two such lines will hence pass through origin. Equation of a plane in $\mathbb{R}^3$ is given by $ax_1 + bx_2 + cx_3  + d= 0$.
Since (0, 0, 0) lies on this plance, we have $d = 0$.
Hence any line in $\mathbb{P}^2$ is uniquely determined by three constants $a, b, c$. We denote a $\mathbb{P}^2$ line by this 3d-vector $(a, b, c)^T$

The points $(x, y, 0)\in \mathbb{P}^2$ are known as ideal points. All ideal points lie on a single line ($x_3 = 0$ plane in $\mathbb{R}^3$). This line is known as line at infinity denoted by $\textbf{1}_{\infty} = (0, 0, 1)^T$

To determine the point of intersection$(t_1, t_2, t_3)$ of two lines $(a_1, b_1, c_1)^T, (a_2, b_2, c_2)^T$, we must have  
$$a_1t_1 + b_1t_2 + c_1t_3 = 0\\\\
a_2t_1 + b_2t_2 + c_2t_3 = 0$$
These equations can be rewrittern as 
$$\begin{bmatrix}t_1 & t_2 & t_3\end{bmatrix} \begin{bmatrix} a_1 & b_1 & c_1 \end{bmatrix}^T = 0 \\\\
    \begin{bmatrix}t_1 & t_2 & t_3\end{bmatrix} \begin{bmatrix} a_2 & b_2 & c_2 \end{bmatrix}^T = 0$$

Or in vector geometry this can be thought as $[t_1, t_2, t_3]^T$ vector is orthogonal to both $[a_1, b_1, c_1]^T$ and $[a_2, b_2, c_2]^T$ vector(which is given by the cross-product of these two vectors)

## Homography
All right! With the above definitions in place, we can proceed to define a projective transformation or what is commonly known as homography.<br>
In purest mathemtical terms a homography is a invertible homomorphism from $\mathbb{P}^2 \rightarrow \mathbb{P}^2$. In a slightly simpler terms a homography is map $f:\mathbb{P}^2 \rightarrow \mathbb{P}^2$ such that $f$ is invertible and $f$ preserves the geometry, i.e. $ \textbf{x}_1, \textbf{x}_2, \textbf{x}_3$ are collinear if and only if $f( \textbf{x}_1), f(\textbf{x}_2), f( \textbf{x}_3) $ are collinear(Lie on a same line $\mathbb{P}^2$ or are coplanar in $\mathbb{R}^3$)
It can be proved that $3\times3$ invertible matrices are the only set of such invertible transformations, i.e. $\textbf{H}: x \mapsto \textbf{H}x$ is a homography where $\textbf{H}$ is an invertible matrix and this is an exhaustive set of homographies on $\mathbb{P}^2$ 

Projective transformations correspond to mapping between multiple perspectives of a same plane, i.e. if an image of a plane is captured with some (X, Y, Z) coordinate system and is also captured with another (x, y, z) coordinate system then there exists a homography $H$ which maps every point from $(X_i, Y_i, Z_i)$ on the plane to the corresponding point $(x_i, y_i, z_i)$  by $\begin{bmatrix}x_i & y_i & z_i\end{bmatrix}^T = H\begin{bmatrix}X_i & Y_i & Z_i\end{bmatrix}^T$

## Direct Linear Transform
Before describing Zhang's algorithm, we need to understand DLT which lies at the core of Zhang's algorithm.<br>
Consider that we have a set of points mapped by a homography($\textbf{H}$: Unknown) given by
$x_i \longleftrightarrow x_i^\prime$, where $x_i^\prime = \textbf{H}x_i$
While if we have 4 equations, we can solve exactly for the matrix $H$, but this method is not practical because of the corresponding measurement errors which make this method unstable and incorrect. We aim to find an approximation of $H$ which is stable(in the sense that small perturbations in the equations params leads to small perturbations in the predicted matrix H) and also leads to least error(i.e. $x_i \approx Hx_i,  \forall i$)

Since $\textbf{x}_i^\prime = Hx_i \in \mathbb{P}^2$,$(0, 0, 0)$,  $\textbf{x}_i^\prime$ and  $H\textbf{x}_i$ are collinear.
Hence $\textbf{x}_i^\prime \times H\textbf{x}_i = 0$<br>


Defining $H = \begin{bmatrix} h_{11} & h_{12} & h_{13} \\\\ h_{21} & h_{22} & h_{23} \\\\ h_{31} & h_{32} & h_{33}\end{bmatrix} = \begin{bmatrix}\textbf{h}_1^T \\\\ \textbf{h}_2^T \\\\ \textbf{h}_3^T\end{bmatrix}$

Let $\textbf{x}_i^\prime = (x_i^\prime, y_i^\prime, w_i^\prime)$, we have


$$\textbf{x}_i^\prime \times H\textbf{x}_i = \begin{bmatrix}y_i^\prime \textbf{h}^{3T}\textbf{x}_i - w_i^\prime\textbf{h}^{2T}\textbf{x}_i \\\\ w_i^\prime \textbf{h}^{1T}\textbf{x}_i - x_i^\prime\textbf{h}^{3T}\textbf{x}_i  \\\\ x_i^\prime \textbf{h}^{2T}\textbf{x}_i - y_i^\prime\textbf{h}^{1T}\textbf{x}_i  \end{bmatrix} = \textbf{O} $$

The above set of equations  can be re-written as $$\begin{bmatrix}\textbf{0}^T & -w_i^\prime \textbf{x}_i^T & y_i^\prime \textbf{x}_i^T \\\\ w_i^\prime\textbf{x}_i^T & \textbf{0}^T & -x_i^\prime \textbf{x}_i^T \\\\ -y_i^\prime\textbf{x}_i^T & x_i^\prime \textbf{x}_i^T & \textbf{0}^T \end{bmatrix}\begin{bmatrix}\textbf{h}_1 \\\\ \textbf{h}_2 \\\\ \textbf{h}_3 \end{bmatrix} = \textbf{0}$$
The matrix $\begin{bmatrix}\textbf{0}^T & -w_i^\prime \textbf{x}_i^T & y_i^\prime \textbf{x}_i^T \\\\ w_i^\prime\textbf{x}_i^T & \textbf{0}^T & -x_i^\prime \textbf{x}_i^T \\\\ -y_i^\prime\textbf{x}_i^T & x_i^\prime \textbf{x}_i^T & \textbf{0}^T \end{bmatrix}$ is a skew-symmetric matrix and hence has rank $\leq 2$. Hence this system is equivalent to 
$$\begin{bmatrix}\textbf{0}^T & -w_i^\prime \textbf{x}_i^T & y_i^\prime \textbf{x}_i^T \\\\ w_i^\prime\textbf{x}_i^T & \textbf{0}^T & -x_i^\prime \textbf{x}_i^T \end{bmatrix}\begin{bmatrix}\textbf{h}_1 \\\\ \textbf{h}_2 \\\\ \textbf{h}_3 \end{bmatrix} = \textbf{0} $$
$$\Rightarrow A_i \textbf{h} = 0$$ where $A_i = \begin{bmatrix}\textbf{0}^T & -w_i^\prime \textbf{x}_i^T & y_i^\prime \textbf{x}_i^T \\\\ w_i^\prime\textbf{x}_i^T & \textbf{0}^T & -x_i^\prime \textbf{x}_i^T \end{bmatrix}$ and $\textbf{h} = \begin{bmatrix}\textbf{h}_1 \\\\ \textbf{h}_2 \\\\ \textbf{h}_3 \end{bmatrix}$

Matrix $H$ is a homogenous matrix , i.e. if $H$ is a solution of the system, then $kH, k\neq0$ is also the solution of the system. Hence to get a unique solution for $H$, we need to add an extra restriction on $H$. We set this restriction as $\lVert h\rVert = 1$. Furthermore due to errors in measurements, we know that the solution for $A\textbf{h} = 0$ may not exist or may be incorrect. Hence we try to minimize the possible value for $\lVert A\textbf{h}\rVert$

It is a well known result in linear algebra that $\displaystyle \min_{\lVert\textbf{h}\rVert = 1}\lVert A\textbf{h}\rVert = \min_{\lVert\textbf{h}\rVert \neq 0 } \displaystyle \frac{\lVert A\textbf{h}\rVert}{\lVert \textbf{h}\rVert}$ and the solution($h$) is the unit singular vector corresponding to the smallest singular value of $A$.

This algorithm is known as Direct Linear Transform.
DLT algoritm becomes stable when we normalize the vectors $\textbf{x}_i$ and $\textbf{x}_i^\prime$
Since normalization is essentially scaling and shift operations in the coordinate space, it can be represented by similarity a matrix.
Let $T$ be the similarity matrix corresponding to $\textbf{x}_i$'s and denote the transformed points as $\tilde{\textbf{x}}_i$. Similarly let $T^\prime$ be the similarity matrix corresponding to $x_i^\prime$ and denote the transformed points as $\tilde{\textbf{x}}_i^\prime$. We find the homography matrix($\tilde{H}$) for the transformed spaces by $\tilde{\textbf{x}}_i \longleftrightarrow \tilde{\textbf{x}}_i^\prime$.
Hence we have
$\tilde{\textbf{x}}_i = T\textbf{x}_i$ from normalization<br> $\tilde{H}\tilde{\textbf{x}}_i = \tilde{\textbf{x}}_i^\prime$ from DLT<br> and $\tilde{\textbf{x}}_i^\prime = T^\prime \textbf{x}_i^\prime$ from normalization

$$\Rightarrow\tilde{H}Tx_i = T^\prime x_i^\prime$$
$$\Rightarrow x_i^\prime = T^{\prime -1}\tilde{H}Tx_i$$
Hence the required homography matrix is given by $H = T^{\prime -1}\tilde{H}T$

## Zhang's Algorithm
In this section we will describe the camera callibration by Zhang's method using a checkerboard pattern.
We will fix the intrinsic and extrinsic parameters by setting the world coordinate system as the checkerboard with plane of checkerboard being the plane $z = 0$ in the world coordinate system.<br>

Using the most generic form of camera matrix, we have for any point $(X, Y, 0)$ on the checkerboard plane, the image point $(x, y) corresponding to that point is given by 

$$\begin{bmatrix}x \\\\ y \\\\ 1\end{bmatrix} = \begin{bmatrix}f_x & s & p_x \\\\ 0 & f_y & p_y \\\\ 0 & 0 & 1\end{bmatrix}\begin{bmatrix}r_{11} & r_{12} & r_{13} & t_1 \\\\ r_{21} & r_{22} & r_{23} & t_2 \\\\ r_{31} & r_{32} & r_{33} & t_3\end{bmatrix}\begin{bmatrix}X \\\\ Y \\\\ 0 \\\\ 1 \end{bmatrix}$$

where $R = \begin{bmatrix}r_{11} & r_{12} & r_{13} \\\\ r_{21} & r_{22} & r_{23} \\\\ r_{31} & r_{32} & r_{33}\end{bmatrix}$ and $C = \begin{bmatrix}-t_1 \\\\ -t_2 \\\\ -t_3\end{bmatrix}$

$$\Rightarrow \begin{bmatrix}x \\\\ y \\\\ 1\end{bmatrix} = \begin{bmatrix}f_x & s & p_x \\\\ 0 & f_y & p_y \\\\ 0 & 0 & 1\end{bmatrix}\begin{bmatrix}r_{11} & r_{12} & t_1 \\\\ r_{21} & r_{22} & t_2 \\\\ r_{31} & r_{32} & t_3\end{bmatrix}\begin{bmatrix}X \\\\ Y \\\\ 1 \end{bmatrix}$$
$$\Rightarrow \begin{bmatrix}x \\\\ y \\\\ 1\end{bmatrix} = K \begin{bmatrix}\textbf{r}_1 & \textbf{r}_2 & \textbf{t}\end{bmatrix} \begin{bmatrix}X \\\\ Y \\\\ 1 \end{bmatrix}$$

The above equation is the same as the equation we took for homography estimation using DLT where $H = K \begin{bmatrix}\textbf{r}_1 & \textbf{r}_2 & \textbf{t}\end{bmatrix}$

We take multiple photos of the checkerboard 

Once estimation of $H$ is done using DLT, we proceed as follows:
$$\begin{bmatrix}\textbf{h}_1 & \textbf{h}_2 & \textbf{h}_3 \end{bmatrix} = \begin{bmatrix}K\textbf{r}_1 & K\textbf{r}_2 & Kt\end{bmatrix}$$

$\Rightarrow \textbf{r}_1 = K^{-1}\textbf{h}_1$ and $\textbf{r}_2 = K^{-1}\textbf{h}_2$

Since $\textbf{r}_1$ and $\textbf{r}_2$ are columns of a normal matrix(Rotation matrix), we have
$\lVert \textbf{r}_i\rVert = 1$ and $\textbf{r}_1^T\textbf{r}_2 = 0$ 
Since $\lVert \textbf{r}_i\rVert^2 = \textbf{r}_i^T\textbf{r}_i$, we have
$\textbf{h}_i^TK^{-T}K^{-1}\textbf{h}_i = 1$ and $\textbf{h}_1^T K^{-T}K^{-1}\textbf{h}_2 = 0$

$\Rightarrow \textbf{h}_1^TK^{-T}K^{-1}\textbf{h}_1 - \textbf{h}_2^TK^{-T}K^{-1}\textbf{h}_2 = 0 $ and $\textbf{h}_1^T K^{-T}K^{-1}\textbf{h}_2 = 0$

Let $B = K^{-T}K^{-1}$, we get the following set of equations
$$\begin{align}
\textbf{h}_1^TB\textbf{h}_1 - \textbf{h}_2^TB\textbf{h}_2 = 0\\\\
\textbf{h}_1^TB\textbf{h}_2 = 0\end{align}$$

Since $B$ is a symmetric matrix, we can set $B=\begin{bmatrix}b_{11} & b_{12} & b_{13} \\\\ b_{12} & b_{22} & b_{23} \\\\ b_{13} & b_{23} & b_{33} \end{bmatrix}$ (6 d.o.f)
Define vector $b = \begin{pmatrix}b_{11} & b_{12} & b_{13} & b_{22} & b_{23} & b_{33}\end{pmatrix}^T$
The above system of equations can be writtern as $V\textbf{b} = 0$

To get a solution different from the trivial solution($\textbf{b} = 0$), we impose a restriction $\lVert b\rVert = 1$
and instead of solving for exact solution $V\textbf{b} = 0$, like DLT, we try to find $\textbf{b}$ which minimizes $\lVert V\textbf{b}\rVert$
After finding the matrix $B$, we then determine $K$ by using Cholesky's decompsition
